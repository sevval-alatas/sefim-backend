import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../prisma/db.js';
import { inspectDwgHeader } from './dwg-converter.service.js';

export interface CadDrawingRecord {
  id: string;
  deviceId: string;
  originalFileName: string;
  fileSizeBytes: number;
  dwgVersion: string | null;
  originalFilePath: string | null;
  convertedFormat: string | null;
  convertedFileName: string | null;
  convertedFilePath: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CadDrawingResponseDto {
  id: string;
  deviceId: string;
  originalFileName: string;
  fileSizeBytes: number;
  dwgVersion: string | null;
  convertedFormat: string | null;
  convertedFileName: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  downloadUrl?: string;
  originalDownloadUrl?: string;
  mobileSceneUrl?: string;
}

@Injectable()
export class CadDrawingService {
  private readonly logger = new Logger(CadDrawingService.name);
  private readonly storageDir = process.env.CAD_STORAGE_DIR || resolve(process.cwd(), 'uploads', 'cad');

  constructor() {
    this.ensureStorageDir();
  }

  private async ensureStorageDir(): Promise<void> {
    try {
      if (!existsSync(this.storageDir)) {
        await mkdir(this.storageDir, { recursive: true });
      }
    } catch (err) {
      this.logger.error(`Storage directory creation error: ${(err as Error).message}`);
    }
  }

  /**
   * Yüklenen DWG dosyasını kalıcı olarak uploads/cad/<drawingId>/ klasörüne kaydeder
   * ve veritabanına deviceId ile 'pending' durumunda yazar.
   */
  async saveUploadedDrawing(file: Express.Multer.File, deviceId: string): Promise<CadDrawingRecord> {
    const cleanDeviceId = (deviceId || 'anonymous-device').trim();
    const drawingId = randomUUID();
    const drawingFolder = join(this.storageDir, drawingId);
    await mkdir(drawingFolder, { recursive: true });

    const safeName = basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    const originalFilePath = join(drawingFolder, `original_${safeName}`);
    await writeFile(originalFilePath, file.buffer);

    const header = inspectDwgHeader(file.buffer);
    const dwgVersion = header.isValidSignature ? header.versionName : null;

    try {
      const record = await db.orm.public.CadDrawing.create({
        id: drawingId,
        deviceId: cleanDeviceId,
        originalFileName: file.originalname,
        fileSizeBytes: file.buffer.length,
        dwgVersion,
        originalFilePath,
        status: 'pending',
      });

      this.logger.log(`CAD çizimi kaydedildi [ID: ${drawingId}, Cihaz: ${cleanDeviceId}, Dosya: ${file.originalname}]`);
      return record as CadDrawingRecord;
    } catch (dbError) {
      this.logger.error(`Veritabanına kayıt başarısız oldu [ID: ${drawingId}]: ${(dbError as Error).message}`);
      // DB hatası durumunda dahi akışın devam edebilmesi için sanal bir kayıt nesnesi oluşturulur
      return {
        id: drawingId,
        deviceId: cleanDeviceId,
        originalFileName: file.originalname,
        fileSizeBytes: file.buffer.length,
        dwgVersion,
        originalFilePath,
        convertedFormat: null,
        convertedFileName: null,
        convertedFilePath: null,
        status: 'pending',
        errorMessage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Çevrilen dosyayı (DXF veya PDF) kalıcı klasöre kopyalar ve veritabanı kaydını günceller.
   */
  async markConversionSuccess(
    drawingId: string,
    params: {
      convertedFormat: 'dxf' | 'pdf';
      convertedFileName: string;
      tempOutputPath: string;
      mobileScenePath?: string;
    },
  ): Promise<void> {
    const drawingFolder = join(this.storageDir, drawingId);
    await mkdir(drawingFolder, { recursive: true });

    const safeConvertedName = basename(params.convertedFileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const permanentConvertedPath = join(drawingFolder, safeConvertedName);

    try {
      if (existsSync(params.tempOutputPath)) {
        await copyFile(params.tempOutputPath, permanentConvertedPath);
      }
    } catch (copyErr) {
      this.logger.warn(`Kalıcı dönüştürülmüş dosya kopyalanamadı: ${(copyErr as Error).message}`);
    }

    if (params.mobileScenePath) {
      if (!existsSync(params.mobileScenePath)) {
        throw new Error('Mobil sahne JSON dosyası dönüştürme çıktısında bulunamadı.');
      }
      await copyFile(
        params.mobileScenePath,
        join(drawingFolder, 'mobile-scene.json'),
      );
    }

    try {
      await db.orm.public.CadDrawing.where({ id: drawingId }).update({
        status: 'success',
        convertedFormat: params.convertedFormat,
        convertedFileName: params.convertedFileName,
        convertedFilePath: permanentConvertedPath,
        errorMessage: null,
      });
      this.logger.log(`CAD çizim dönüşümü tamamlandı ve DB güncellendi [ID: ${drawingId}, Format: ${params.convertedFormat}]`);
    } catch (dbErr) {
      this.logger.error(`DB güncelleme hatası (markConversionSuccess): ${(dbErr as Error).message}`);
    }
  }

  /**
   * Dönüşüm başarısız olduğunda veritabanı kaydını hata durumuna geçirir.
   */
  async markConversionFailed(drawingId: string, errorMessage: string): Promise<void> {
    try {
      await db.orm.public.CadDrawing.where({ id: drawingId }).update({
        status: 'failed',
        errorMessage: errorMessage.slice(0, 1000),
      });
      this.logger.warn(`CAD çizim dönüşümü başarısız işaretlendi [ID: ${drawingId}]`);
    } catch (dbErr) {
      this.logger.error(`DB güncelleme hatası (markConversionFailed): ${(dbErr as Error).message}`);
    }
  }

  /**
   * Belirtilen deviceId'ye ait tüm çizimleri listeler (en yeni en başta).
   */
  async getDrawingsByDeviceId(deviceId: string): Promise<CadDrawingResponseDto[]> {
    const cleanDeviceId = (deviceId || '').trim();
    if (!cleanDeviceId) return [];

    try {
      const records = await db.orm.public.CadDrawing
        .where({ deviceId: cleanDeviceId })
        .orderBy((d) => d.createdAt.desc())
        .all();

      return records.map((record) => this.toResponseDto(record as CadDrawingRecord));
    } catch (dbErr) {
      this.logger.error(`Cihaza göre çizim listeleme hatası [Cihaz: ${cleanDeviceId}]: ${(dbErr as Error).message}`);
      return [];
    }
  }

  /**
   * Belirtilen ID'ye sahip çizimi getirir.
   */
  async getDrawingById(drawingId: string): Promise<CadDrawingRecord | null> {
    try {
      const record = await db.orm.public.CadDrawing.where({ id: drawingId }).first();
      return (record as CadDrawingRecord) || null;
    } catch (dbErr) {
      this.logger.error(`Çizim getirme hatası [ID: ${drawingId}]: ${(dbErr as Error).message}`);
      return null;
    }
  }

  /**
   * Çizimi ve ilişkili dosyalarını siler.
   */
  async deleteDrawing(drawingId: string, deviceId?: string): Promise<boolean> {
    try {
      const existing = await this.getDrawingById(drawingId);
      if (!existing) {
        throw new NotFoundException(`Çizim bulunamadı [ID: ${drawingId}]`);
      }

      if (deviceId && existing.deviceId !== deviceId) {
        throw new NotFoundException(`Bu çizim belirtilen cihaza ait değil`);
      }

      await db.orm.public.CadDrawing.where({ id: drawingId }).delete();

      const drawingFolder = join(this.storageDir, drawingId);
      await rm(drawingFolder, { recursive: true, force: true }).catch(() => {});

      this.logger.log(`Çizim ve dosyaları silindi [ID: ${drawingId}]`);
      return true;
    } catch (err) {
      this.logger.error(`Çizim silme hatası [ID: ${drawingId}]: ${(err as Error).message}`);
      throw err;
    }
  }

  toResponseDto(record: CadDrawingRecord): CadDrawingResponseDto {
    const mobileScenePath = join(this.storageDir, record.id, 'mobile-scene.json');
    return {
      id: record.id,
      deviceId: record.deviceId,
      originalFileName: record.originalFileName,
      fileSizeBytes: record.fileSizeBytes,
      dwgVersion: record.dwgVersion,
      convertedFormat: record.convertedFormat,
      convertedFileName: record.convertedFileName,
      status: record.status,
      errorMessage: record.errorMessage,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      downloadUrl: record.convertedFileName ? `/api/cad/drawings/${record.id}/download` : undefined,
      originalDownloadUrl: `/api/cad/drawings/${record.id}/download?type=original`,
      mobileSceneUrl: existsSync(mobileScenePath)
        ? `/api/cad/drawings/${record.id}/scene`
        : undefined,
    };
  }

  getMobileScenePath(drawingId: string): string {
    return join(this.storageDir, drawingId, 'mobile-scene.json');
  }
}
