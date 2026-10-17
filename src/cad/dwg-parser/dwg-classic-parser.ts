import { IDwgVersionParser, ParseResult, CadEntity } from './parser-strategy.js';
import { BitReader } from './bit-reader.js';
import { DwgEntity, DwgLine, DwgCircle, DwgArc, DwgLWPolyline, DwgLayer, DwgInsert } from './object-factory.js';

export class DwgClassicParser implements IDwgVersionParser {
  private readonly version: string;

  constructor(version: string) {
    this.version = version;
  }

  parse(buffer: Buffer): ParseResult {
    try {
      if (buffer.length < 6) {
        return { success: false, version: this.version, entities: [], error: 'Dosya çok kısa' };
      }

      const entities: CadEntity[] = [];
      const reader = new BitReader(buffer);
      reader.offset = 0x40 * 8;

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
              const layer = reader.readString ? reader.readString() : '';
              const start = this.readPoint(reader);
              const end = this.readPoint(reader);
              entities.push({ type: 'LINE', start, end, layer });
              break;
            }
            case ENTITY_CIRCLE: {
              const layer = reader.readString ? reader.readString() : '';
              const center = this.readPoint(reader);
              const radius = reader.readBitDouble();
              entities.push({ type: 'CIRCLE', center, radius, layer });
              break;
            }
            case ENTITY_ARC: {
              const layer = reader.readString ? reader.readString() : '';
              const center = this.readPoint(reader);
              const radius = reader.readBitDouble();
              const startAngle = reader.readBitDouble();
              const endAngle = reader.readBitDouble();
              entities.push({ type: 'ARC', center, radius, startAngle, endAngle, layer });
              break;
            }
            case ENTITY_LWPOLYLINE: {
              const layer = reader.readString ? reader.readString() : '';
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
              const name = reader.readString ? reader.readString() : '';
              const on = reader.readBit() === 1;
              entities.push({ type: 'LAYER', name, on });
              break;
            }
            case ENTITY_INSERT: {
              const name = reader.readString ? reader.readString() : '';
              const layer = reader.readString ? reader.readString() : '';
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

  private readPoint(reader: BitReader): { x: number; y: number; z?: number } {
    const x = reader.readBitDouble();
    const y = reader.readBitDouble();
    const zFlag = reader.readBit();
    const z = zFlag === 1 ? reader.readBitDouble() : 0;
    return { x, y, z };
  }
}
