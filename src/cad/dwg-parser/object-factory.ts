import { BitReader } from './bit-reader.js';

export type DwgPoint = { x: number; y: number; z?: number };

export type DwgLine = {
  type: 'LINE';
  start: DwgPoint;
  end: DwgPoint;
  layer: string;
  color?: number;
};

export type DwgCircle = {
  type: 'CIRCLE';
  center: DwgPoint;
  radius: number;
  layer: string;
  color?: number;
};

export type DwgArc = {
  type: 'ARC';
  center: DwgPoint;
  radius: number;
  startAngle: number;
  endAngle: number;
  layer: string;
  color?: number;
};

export type DwgLWPolyline = {
  type: 'LWPOLYLINE';
  vertices: DwgPoint[];
  layer: string;
  color?: number;
  closed?: boolean;
};

export type DwgLayer = {
  type: 'LAYER';
  name: string;
  color?: number;
  on: boolean;
};

export type DwgInsert = {
  type: 'INSERT';
  name: string;
  insertionPoint: DwgPoint;
  scale: DwgPoint;
  rotation: number;
  layer: string;
};

export type DwgEntity =
  | DwgLine
  | DwgCircle
  | DwgArc
  | DwgLWPolyline
  | DwgLayer
  | DwgInsert;

export class ObjectFactory {
  private readonly reader: BitReader;

  constructor(buffer: Buffer, startBitOffset: number = 0) {
    this.reader = new BitReader(buffer);
    this.reader.offset = startBitOffset;
  }

  private readString(): string {
    const reader = this.reader;
    const len = reader.readModularChar();
    if (len <= 0) return '';
    const bytes = reader.readRawBytes(len);
    return bytes.toString('utf8');
  }

  private readPoint(): DwgPoint {
    const reader = this.reader;
    const x = reader.readBitDouble();
    const y = reader.readBitDouble();
    const zFlag = reader.readBit();
    const z = zFlag === 1 ? reader.readBitDouble() : 0;
    return { x, y, z };
  }

  parseEntity(): DwgEntity | null {
    const reader = this.reader;
    const typeCode = reader.readModularChar();

    switch (typeCode) {
      case 1: {
        const layer = this.readString();
        const color = reader.readModularChar();
        const start = this.readPoint();
        const end = this.readPoint();
        return { type: 'LINE', start, end, layer, color };
      }
      case 2: {
        const layer = this.readString();
        const color = reader.readModularChar();
        const center = this.readPoint();
        const radius = reader.readBitDouble();
        return { type: 'CIRCLE', center, radius, layer, color };
      }
      case 3: {
        const layer = this.readString();
        const color = reader.readModularChar();
        const center = this.readPoint();
        const radius = reader.readBitDouble();
        const startAngle = reader.readBitDouble();
        const endAngle = reader.readBitDouble();
        return { type: 'ARC', center, radius, startAngle, endAngle, layer, color };
      }
      case 4: {
        const layer = this.readString();
        const color = reader.readModularChar();
        const vertexCount = reader.readModularChar();
        const closedFlag = reader.readBit();
        const vertices: DwgPoint[] = [];
        for (let i = 0; i < vertexCount; i++) {
          vertices.push(this.readPoint());
        }
        return { type: 'LWPOLYLINE', vertices, layer, color, closed: closedFlag === 1 };
      }
      case 5: {
        const name = this.readString();
        const color = reader.readModularChar();
        const onFlag = reader.readBit();
        return { type: 'LAYER', name, color, on: onFlag === 1 };
      }
      case 6: {
        const name = this.readString();
        const layer = this.readString();
        const insertionPoint = this.readPoint();
        const sx = reader.readBitDouble();
        const sy = reader.readBitDouble();
        const sz = reader.readBitDouble();
        const rotation = reader.readBitDouble();
        return {
          type: 'INSERT',
          name,
          insertionPoint,
          scale: { x: sx, y: sy, z: sz },
          rotation,
          layer,
        };
      }
      default:
        return null;
    }
  }

  parseAllEntities(maxEntities: number = 10000): DwgEntity[] {
    const entities: DwgEntity[] = [];
    let count = 0;
    while (count < maxEntities && this.reader.remainingBits > 8) {
      const savedOffset = this.reader.offset;
      try {
        const entity = this.parseEntity();
        if (entity) {
          entities.push(entity);
        } else {
          this.reader.offset = savedOffset;
          break;
        }
      } catch {
        this.reader.offset = savedOffset;
        break;
      }
      count += 1;
    }
    return entities;
  }
}
