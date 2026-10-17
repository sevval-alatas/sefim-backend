import { IDwgVersionParser, ParseResult, CadEntity } from './parser-strategy.js';
import { BitReader } from './bit-reader.js';

export class DwgModernParser implements IDwgVersionParser {
  private readonly version: string;

  constructor(version: string) {
    this.version = version;
  }

  parse(buffer: Buffer): ParseResult {
    try {
      if (buffer.length < 0x100) {
        return { success: false, version: this.version, entities: [], error: 'AC1032+ dosya çok kısa' };
      }

      const entities: CadEntity[] = [];

      const pageTableOffset = 0x100;
      if (buffer.length < pageTableOffset + 32) {
        return { success: false, version: this.version, entities: [], error: 'AC1032+ sayfa tablosu bulunamadı' };
      }

      const reader = new BitReader(buffer);
      reader.offset = pageTableOffset * 8;

      const ENTITY_LINE = 19;
      const ENTITY_ARC = 16;
      const ENTITY_CIRCLE = 2;
      const ENTITY_LAYER = 5;
      const ENTITY_LWPOLYLINE = 4;
      const ENTITY_INSERT = 6;

      while (reader.remainingBits > 16) {
        const savedOffset = reader.offset;
        const entityType = reader.readModularChar();

        try {
          switch (entityType) {
            case ENTITY_LINE: {
              const layer = this.readString(reader);
              const start = this.readPoint(reader);
              const end = this.readPoint(reader);
              entities.push({ type: 'LINE', start, end, layer });
              break;
            }
            case ENTITY_CIRCLE: {
              const layer = this.readString(reader);
              const center = this.readPoint(reader);
              const radius = reader.readBitDouble();
              entities.push({ type: 'CIRCLE', center, radius, layer });
              break;
            }
            case ENTITY_ARC: {
              const layer = this.readString(reader);
              const center = this.readPoint(reader);
              const radius = reader.readBitDouble();
              const startAngle = reader.readBitDouble();
              const endAngle = reader.readBitDouble();
              entities.push({ type: 'ARC', center, radius, startAngle, endAngle, layer });
              break;
            }
            case ENTITY_LWPOLYLINE: {
              const layer = this.readString(reader);
              const vertexCount = reader.readModularChar();
              const closed = reader.readBit() === 1;
              const vertices = [];
              for (let i = 0; i < vertexCount; i++) {
                vertices.push(this.readPoint(reader));
              }
              entities.push({ type: 'LWPOLYLINE', vertices, layer, closed });
              break;
            }
            case ENTITY_LAYER: {
              const name = this.readString(reader);
              const on = reader.readBit() === 1;
              entities.push({ type: 'LAYER', name, on });
              break;
            }
            case ENTITY_INSERT: {
              const name = this.readString(reader);
              const layer = this.readString(reader);
              const insertionPoint = this.readPoint(reader);
              const sx = reader.readBitDouble();
              const sy = reader.readBitDouble();
              const sz = reader.readBitDouble();
              const rotation = reader.readBitDouble();
              entities.push({ type: 'INSERT', name, insertionPoint, scale: { x: sx, y: sy, z: sz }, rotation, layer });
              break;
            }
            default: {
              reader.offset = savedOffset;
              return { success: true, version: this.version, entities };
            }
          }
        } catch {
          reader.offset = savedOffset;
          break;
        }
      }

      return { success: true, version: this.version, entities };
    } catch (error) {
      return {
        success: false,
        version: this.version,
        entities: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private readString(reader: BitReader): string {
    const len = reader.readModularChar();
    if (len <= 0) return '';
    const bytes = reader.readRawBytes(len);
    return bytes.toString('utf8');
  }

  private readPoint(reader: BitReader): { x: number; y: number; z?: number } {
    const x = reader.readBitDouble();
    const y = reader.readBitDouble();
    const zFlag = reader.readBit();
    const z = zFlag === 1 ? reader.readBitDouble() : 0;
    return { x, y, z };
  }
}
