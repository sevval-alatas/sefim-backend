import { execFile } from 'node:child_process';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  BadGatewayException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const MAX_CONCURRENT_CONVERSIONS = 3;
const CONVERSION_TIMEOUT_MS = 60_000;
const FILE_RETENTION_MS = 10 * 60_000;

type ConvertedFile = {
  path: string;
  name: string;
};

@Injectable()
export class DwgConverterService {
  private readonly converterCommand = process.env.CAD_CONVERTER_COMMAND ?? 'dwg2dxf';
  private readonly dxfVersion = process.env.CAD_DXF_VERSION ?? 'r2018';
  private readonly convertedFiles = new Map<string, ConvertedFile>();
  private activeConversions = 0;

  async convert(file: Express.Multer.File) {
    if (this.activeConversions >= MAX_CONCURRENT_CONVERSIONS) {
      throw new ServiceUnavailableException('Conversion capacity is temporarily full');
    }

    this.activeConversions += 1;
    const fileId = randomUUID();
    const jobDirectory = join(tmpdir(), 'sefim-cad', fileId);
    const inputPath = join(jobDirectory, 'input.dwg');
    const converterOutputPath = join(jobDirectory, 'input.dxf');
    const outputPath = join(jobDirectory, 'output.dxf');

    try {
      await mkdir(jobDirectory, { recursive: true });
      await writeFile(inputPath, file.buffer);

      try {
        await execFileAsync(
          this.converterCommand,
          ['--overwrite', '--as', this.dxfVersion, inputPath],
          {
          cwd: jobDirectory,
          timeout: CONVERSION_TIMEOUT_MS,
          windowsHide: true,
          },
        );
      } catch (error) {
        await rm(jobDirectory, { recursive: true, force: true });
        if (this.isMissingCommandError(error)) {
          throw new ServiceUnavailableException(
            `DWG converter is unavailable: ${this.converterCommand}`,
          );
        }
        throw new BadGatewayException('DWG to DXF conversion failed');
      }

      await rename(converterOutputPath, outputPath);
      this.convertedFiles.set(fileId, {
        path: outputPath,
        name: this.toDxfName(file.originalname),
      });
      setTimeout(() => void this.removeConvertedFile(fileId), FILE_RETENTION_MS).unref();

      return {
        success: true,
        fileId,
        fileName: this.toDxfName(file.originalname),
        downloadUrl: `/api/cad/files/${fileId}`,
      };
    } catch (error) {
      await rm(jobDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      this.activeConversions -= 1;
    }
  }

  async getConvertedFile(fileId: string) {
    const convertedFile = this.convertedFiles.get(fileId);
    if (!convertedFile) {
      throw new NotFoundException('Converted file not found or expired');
    }

    try {
      await access(convertedFile.path);
    } catch {
      this.convertedFiles.delete(fileId);
      throw new NotFoundException('Converted file not found or expired');
    }

    return convertedFile;
  }

  private async removeConvertedFile(fileId: string) {
    const convertedFile = this.convertedFiles.get(fileId);
    if (!convertedFile) return;

    this.convertedFiles.delete(fileId);
    await rm(join(convertedFile.path, '..'), { recursive: true, force: true });
  }

  private toDxfName(originalName: string) {
    return `${originalName.replace(/\.dwg$/i, '')}.dxf`;
  }

  private isMissingCommandError(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
  }
}