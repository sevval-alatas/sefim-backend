import { Injectable, Logger, BadRequestException, InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export type AndroidDwgReaderResult = {
  success: boolean;
  total_entities: number;
  layers_found: string[];
  entity_types: Record<string, number>;
  entities: unknown[];
  error?: string;
};

@Injectable()
export class DwgAndroidBridgeService {
  private readonly logger = new Logger(DwgAndroidBridgeService.name);
  private readonly bridgeCommand: string;
  private readonly bridgeArgs: string[];
  private readonly bridgeUrl: string | undefined;
  private readonly available: boolean;

  constructor() {
    this.bridgeCommand = process.env.ANDROID_DWG_BRIDGE_COMMAND ?? '';
    const argsRaw = process.env.ANDROID_DWG_BRIDGE_ARGS;
    this.bridgeArgs = argsRaw ? argsRaw.split(' ') : [];
    this.bridgeUrl = process.env.ANDROID_DWG_BRIDGE_URL;
    this.available = this.bridgeCommand.length > 0 && existsSync(this.bridgeCommand);
  }

  async isAvailable(): Promise<boolean> {
    if (this.bridgeUrl) return true;
    if (!this.available) return false;
    try {
      await stat(this.bridgeCommand);
      return true;
    } catch {
      return false;
    }
  }

  async readDwg(buffer: Buffer, originalName: string): Promise<AndroidDwgReaderResult> {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('DWG dosyası boş.');
    }

    if (this.bridgeUrl) {
      return this.readViaHttp(buffer, originalName);
    }

    if (!this.available) {
      throw new ServiceUnavailableException('Android DWG bridge komutu yapılandırılmamış veya erişilebilir değil.');
    }

    const fileId = randomUUID();
    const jobDirectory = join(tmpdir(), 'sefim-android-dwg', fileId);
    const inputPath = join(jobDirectory, 'input.dwg');

    try {
      await mkdir(jobDirectory, { recursive: true });
      await writeFile(inputPath, buffer);
      return await this.spawnBridge(inputPath, originalName);
    } finally {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async readViaHttp(buffer: Buffer, originalName: string): Promise<AndroidDwgReaderResult> {
    try {
      const boundary = `----WebKitFormBoundary${randomUUID()}`;
      const fields: Buffer[] = [];

      const fileHeader = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${originalName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        'utf8',
      );
      const fileFooter = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

      const body = Buffer.concat([...fields, fileHeader, buffer, fileFooter]);

      const response = await fetch(`${this.bridgeUrl}/ocr`, {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(body.length),
        },
        body,
        signal: AbortSignal.timeout(180_000),
      });

      if (!response.ok) {
        throw new InternalServerErrorException(`Android bridge HTTP hata: ${response.status}`);
      }

      const result: AndroidDwgReaderResult = await response.json();
      if (!result.success) {
        throw new BadRequestException(result.error || 'DWG okunamadı.');
      }
      return result;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof InternalServerErrorException) throw error;
      throw new InternalServerErrorException(`Android bridge HTTP hatası: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private spawnBridge(inputPath: string): Promise<AndroidDwgReaderResult> {
    return new Promise((resolve, reject) => {
      let stdoutAcc = '';
      let stderrAcc = '';

      const child = spawn(this.bridgeCommand, [...this.bridgeArgs, inputPath], {
        windowsHide: true,
        env: { ...process.env },
      });

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new InternalServerErrorException('Android DWG okuma işlemi zaman aşımına uğradı.'));
      }, 180_000);
      timeout.unref();

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutAcc += chunk.toString('utf8');
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrAcc += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(new InternalServerErrorException(`Android DWG bridge başlatılamadı: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new InternalServerErrorException(`Android DWG bridge hata kodu ${code}: ${stderrAcc || stdoutAcc}`));
          return;
        }
        try {
          const result: AndroidDwgReaderResult = JSON.parse(stdoutAcc);
          if (!result.success) {
            reject(new BadRequestException(result.error || 'DWG okunamadı.'));
            return;
          }
          resolve(result);
        } catch {
          reject(new InternalServerErrorException('Android DWG çıkışı çözümlenemedi.'));
        }
      });
    });
  }
}
