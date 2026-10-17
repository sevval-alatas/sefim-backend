/**
 * DWG okuyucu servis: Native reader'ı wrapper olarak sunar.
 */

import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export type DwgEntity = {
  handle: string;
  type: string;
  layer: string;
  color: number | string;
  linetype: string;
  bounds: {
    min_x: number;
    min_y: number;
    max_x: number;
    max_y: number;
    points: [number, number][];
  } | null;
};

export type DwgReaderResult = {
  success: boolean;
  total_entities: number;
  layers_found: string[];
  entity_types: Record<string, number>;
  entities: DwgEntity[];
  error?: string;
};

@Injectable()
export class DwgReaderService {
  private readonly logger = new Logger(DwgReaderService.name);
  private readonly pythonPath: string;
  private readonly workerScript: string;

  constructor() {
    this.pythonPath = process.env.DWG_PYTHON_PATH || 'python';
    this.workerScript = process.env.DWG_WORKER_SCRIPT || join(__dirname, '../../../python/dwg_worker/main.py');
  }

  async readDwg(filePath: string): Promise<DwgReaderResult> {
    if (!existsSync(filePath)) {
      throw new BadRequestException('DWG dosyası disk üzerinde bulunamadı.');
    }

    this.logger.log(`DWG okuma başlatıldı: ${filePath}`);

    return new Promise((resolve, reject) => {
      let stdoutAcc = '';
      let stderrAcc = '';

      const child = spawn(this.pythonPath, [this.workerScript, filePath], {
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new InternalServerErrorException('DWG okuma işlemi zaman aşımına uğradı (3 dakika).'));
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
        this.logger.error(`Python işlem hatası: ${err.message}`);
        reject(new InternalServerErrorException(`DWG okuma işlemi başlatılamadı: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          this.logger.error(`Python worker çıkış kodu: ${code}, stderr: ${stderrAcc}`);
          reject(new InternalServerErrorException(`DWG okunamadı (kod ${code}): ${stderrAcc || stdoutAcc}`));
          return;
        }

        try {
          const result: DwgReaderResult = JSON.parse(stdoutAcc);
          if (!result.success) {
            reject(new BadRequestException(result.error || 'DWG okunamadı.'));
            return;
          }
          this.logger.log(`DWG okuma tamamlandı: ${result.total_entities} nesne, ${result.layers_found.length} katman`);
          resolve(result);
        } catch (parseErr) {
          this.logger.error(`JSON parse hatası: ${parseErr.message}, stdout: ${stdoutAcc.slice(0, 500)}`);
          reject(new InternalServerErrorException('DWG çıkışı çözümlenemedi.'));
        }
      });
    });
  }

  async readUploadedFile(buffer: Buffer, originalName: string): Promise<DwgReaderResult> {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('DWG dosyası boş.');
    }

    const fileId = randomUUID();
    const jobDirectory = join(tmpdir(), 'sefim-cad-read', fileId);
    const inputPath = join(jobDirectory, 'input.dwg');

    try {
      await mkdir(jobDirectory, { recursive: true });
      await writeFile(inputPath, buffer);
      return await this.readDwg(inputPath);
    } finally {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async checkWorkerAvailable(): Promise<{ available: boolean; pythonPath: string; scriptPath: string }> {
    let pythonExists = false;
    let scriptExists = false;

    try {
      await stat(this.pythonPath);
      pythonExists = true;
    } catch {}

    try {
      await stat(this.workerScript);
      scriptExists = true;
    } catch {}

    return {
      available: pythonExists && scriptExists,
      pythonPath: this.pythonPath,
      scriptPath: this.workerScript,
    };
  }
}
