import {
  DwgEntity,
  DwgLine,
  DwgCircle,
  DwgArc,
  DwgLWPolyline,
  DwgLayer,
  DwgInsert,
  DwgPoint,
} from './object-factory.js';

export type ExportedElement =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; layer: string; color?: number }
  | { kind: 'circle'; cx: number; cy: number; r: number; layer: string; color?: number }
  | {
      kind: 'arc';
      cx: number;
      cy: number;
      r: number;
      startAngle: number;
      endAngle: number;
      layer: string;
      color?: number;
    }
  | {
      kind: 'polyline';
      points: { x: number; y: number }[];
      closed: boolean;
      layer: string;
      color?: number;
    }
  | { kind: 'layer'; name: string; color?: number; on: boolean }
  | { kind: 'insert'; name: string; x: number; y: number; sx: number; sy: number; rotation: number; layer: string };

export type ExportedDrawing = {
  version: string;
  elements: ExportedElement[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
};

export class VectorExporter {
  static export(entities: DwgEntity[], version: string): ExportedDrawing {
    const elements: ExportedElement[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const updateBounds = (point: DwgPoint): void => {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    };

    for (const entity of entities) {
      switch (entity.type) {
        case 'LINE': {
          updateBounds(entity.start);
          updateBounds(entity.end);
          elements.push({
            kind: 'line',
            x1: entity.start.x,
            y1: entity.start.y,
            x2: entity.end.x,
            y2: entity.end.y,
            layer: entity.layer,
            color: entity.color,
          });
          break;
        }
        case 'CIRCLE': {
          updateBounds(entity.center);
          elements.push({
            kind: 'circle',
            cx: entity.center.x,
            cy: entity.center.y,
            r: entity.radius,
            layer: entity.layer,
            color: entity.color,
          });
          break;
        }
        case 'ARC': {
          updateBounds(entity.center);
          elements.push({
            kind: 'arc',
            cx: entity.center.x,
            cy: entity.center.y,
            r: entity.radius,
            startAngle: entity.startAngle,
            endAngle: entity.endAngle,
            layer: entity.layer,
            color: entity.color,
          });
          break;
        }
        case 'LWPOLYLINE': {
          for (const vertex of entity.vertices) {
            updateBounds(vertex);
          }
          elements.push({
            kind: 'polyline',
            points: entity.vertices.map((v) => ({ x: v.x, y: v.y })),
            closed: entity.closed ?? false,
            layer: entity.layer,
            color: entity.color,
          });
          break;
        }
        case 'LAYER': {
          elements.push({
            kind: 'layer',
            name: entity.name,
            color: entity.color,
            on: entity.on,
          });
          break;
        }
        case 'INSERT': {
          updateBounds(entity.insertionPoint);
          elements.push({
            kind: 'insert',
            name: entity.name,
            x: entity.insertionPoint.x,
            y: entity.insertionPoint.y,
            sx: entity.scale.x,
            sy: entity.scale.y,
            rotation: entity.rotation,
            layer: entity.layer,
          });
          break;
        }
      }
    }

    const bounds =
      minX === Infinity
        ? null
        : { minX, minY, maxX, maxY };

    return { version, elements, bounds };
  }

  static toJSON(drawing: ExportedDrawing): string {
    return JSON.stringify(drawing, null, 2);
  }
}
