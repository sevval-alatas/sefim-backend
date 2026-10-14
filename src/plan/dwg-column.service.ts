import { spawn } from 'node:child_process';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { join } from 'node:path';

export type ColumnBounds = {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type WorkerResult = {
  success: true;
  columns: ColumnBounds[];
  warnings: string[];
};

const WORKER_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function parseWorkerResult(stdout: string): WorkerResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new BadGatewayException('DWG worker geçerli JSON döndürmedi');
  }
  if (!value || typeof value !== 'object') {
    throw new BadGatewayException('DWG worker yanıtı beklenen biçimde değil');
  }

  const result = value as Record<string, unknown>;
  if (result.success !== true) {
    const error = typeof result.error === 'string' ? result.error : 'DWG okunamadı';
    throw new BadRequestException(error);
  }
  if (!Array.isArray(result.columns) || !result.columns.every(isColumnBounds)) {
    throw new BadGatewayException('DWG worker kolon verisi beklenen biçimde değil');
  }
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  return { success: true, columns: result.columns, warnings };
}

function isColumnBounds(value: unknown): value is ColumnBounds {
  if (!value || typeof value !== 'object') return false;
  const column = value as Record<string, unknown>;
  return typeof column.name === 'string'
    && ['minX', 'minY', 'maxX', 'maxY'].every(
      (key) => typeof column[key] === 'number' && Number.isFinite(column[key]),
    );
}


@Injectable()
export class DwgColumnService {
  async extract(filePath: string): Promise<WorkerResult> {
    const pythonPath = process.env.DWG_PYTHON_PATH;
    if (!pythonPath) {
      throw new ServiceUnavailableException('DWG_PYTHON_PATH ortam değişkeni tanımlı değil');
    }

    const workerPath = process.env.DWG_WORKER_SCRIPT
      ? join(process.cwd(), process.env.DWG_WORKER_SCRIPT)
      : join(process.cwd(), 'python', 'dwg_worker', 'main.py');

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(pythonPath, [workerPath, filePath], {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        env: process.env,
      });
      let output = '';
      let errorOutput = '';
      let outputBytes = 0;
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new BadGatewayException('DWG işleme zaman aşımına uğradı'));
      }, WORKER_TIMEOUT_MS);
      timeout.unref();

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          clearTimeout(timeout);
          reject(new BadGatewayException('DWG worker çıktısı izin verilen sınırı aştı'));
          return;
        }
        output += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (errorOutput.length < 8_000) errorOutput += chunk;
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        if (error.code === 'ENOENT') {
          reject(new ServiceUnavailableException(`Python çalıştırıcısı bulunamadı: ${pythonPath}`));
        } else {
          reject(new BadGatewayException('DWG worker başlatılamadı'));
        }
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0 && !output.trim()) {
          reject(new BadGatewayException(`DWG worker başarısız oldu${errorOutput ? `: ${errorOutput.trim()}` : ''}`));
          return;
        }
        resolve(output);
      });
    });

    return parseWorkerResult(stdout);
  }
}
