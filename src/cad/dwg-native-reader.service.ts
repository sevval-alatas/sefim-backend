/**
 * OrkeSTRATÖR servis: DWG dosyasını okur, DXF'e çevirir ve sonucu döner.
 */

import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DwgFiler } from './dwg-filer.js';
import { CadDatabase } from './dwg-model.js';
import { CadToDxfRenderer } from './dwg-renderer.js';

export type NativeReadResult = {
  success: boolean;
  database: CadDatabase;
  dxfOutput: string;
  entityCount: number;
  layerCount: number;
  error?: string;
};

@Injectable()
export class DwgNativeReaderService {
  private readonly logger = new Logger(DwgNativeReaderService.name);

  async readDwgFile(filePath: string): Promise<NativeReadResult> {
    if (!existsSync(filePath)) {
      throw new BadRequestException('DWG dosyası disk üzerinde bulunamadı.');
    }

    const buffer = await readFile(filePath);
    return this.processBuffer(buffer);
  }

  async readBuffer(buffer: Buffer): Promise<NativeReadResult> {
    return this.processBuffer(buffer);
  }

  private async processBuffer(buffer: Buffer): Promise<NativeReadResult> {
    const filer = new DwgFiler();
    let database: CadDatabase;

    try {
      database = filer.load(buffer);
    } catch (err) {
      this.logger.error(`DWG filer hata: ${err}`);
      return {
        success: false,
        database: new CadDatabase(),
        dxfOutput: '',
        entityCount: 0,
        layerCount: 0,
        error: err instanceof Error ? err.message : 'Bilinmeyen hata',
      };
    }

    const renderer = new CadToDxfRenderer();
    const dxfOutput = renderer.render(database) as string;

    return {
      success: true,
      database,
      dxfOutput,
      entityCount: database.entities.length,
      layerCount: database.layers.size,
    };
  }
}
