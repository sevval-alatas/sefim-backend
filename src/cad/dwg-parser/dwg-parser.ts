import { BitReader } from './bit-reader.js';
import { LZODecompressor } from './lzo-decompressor.js';
import { SectionManager, DwgHeader } from './section-manager.js';
import { ObjectFactory, DwgEntity } from './object-factory.js';
import { VectorExporter, ExportedDrawing } from './vector-exporter.js';

export type ParseResult = {
  success: boolean;
  drawing?: ExportedDrawing;
  header?: DwgHeader;
  entities?: DwgEntity[];
  error?: string;
};

export class DwgParser {
  async parse(buffer: Buffer): Promise<ParseResult> {
    try {
      if (buffer.length < 6) {
        return { success: false, error: 'Dosya çok kısa, DWG başlığı okunamadı' };
      }

      const sectionManager = new SectionManager(buffer);
      const header = sectionManager.readHeader();

      if (!header.isValid) {
        return {
          success: false,
          error: `Geçersiz DWG imzası: ${header.signature}`,
          header,
        };
      }

      const isCompressed = /^(AC1018|AC1021|AC1024|AC1027|AC1032|AC1036)$/.test(
        header.signature,
      );

      let workingBuffer = buffer;
      if (isCompressed) {
        try {
          workingBuffer = LZODecompressor.decompress(buffer);
        } catch {
          workingBuffer = buffer;
        }
      }

      const sections = sectionManager.readSections();
      const objectMap = sections.find((s) => s.name.includes('OBJECT') || s.name.includes('OBJECT_MAP'));

      const factory = new ObjectFactory(workingBuffer);
      const entities = factory.parseAllEntities();

      const drawing = VectorExporter.export(entities, header.version);

      return {
        success: true,
        header,
        entities,
        drawing,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export { BitReader, LZODecompressor, SectionManager, ObjectFactory, VectorExporter };
export type { DwgEntity, ExportedDrawing, DwgHeader };
