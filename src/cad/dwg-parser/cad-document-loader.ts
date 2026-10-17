import { DwgParserFactory } from './dwg-parser-factory.js';
import { ParseResult, CadEntity } from './parser-strategy.js';
import { inspectDwgHeader, type DwgHeaderInfo } from '../dwg-converter.service.js';
import type { DwgHeader } from './section-manager.js';

export class CadDocumentLoader {
  static loadDwg(buffer: Buffer): ParseResult {
    if (buffer.length < 6) {
      return { success: false, entities: [], error: 'Dosya boyutu çok küçük, DWG başlığı okunamadı' };
    }

    const signature = buffer.subarray(0, 6).toString('ascii');
    const headerInfo: DwgHeaderInfo = inspectDwgHeader(buffer);

    if (!headerInfo.isValidSignature) {
      return { success: false, entities: [], error: `Geçersiz DWG imzası: ${signature}` };
    }

    const parser = DwgParserFactory.createParser(signature);
    const result = parser.parse(buffer);

    return {
      success: result.success,
      version: headerInfo.versionName,
      entities: result.entities,
      error: result.error,
    };
  }
}

export type { ParseResult, CadEntity, DwgHeader };
