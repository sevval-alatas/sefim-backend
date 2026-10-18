/**
 * Katman E: DWG'yi mobil uyumlu SVG'ye dönüştürür.
 * SVG, mobil cihazlarda vektörel, küçük boyutlu ve hızlı render eden bir formattır.
 */

import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DwgFiler } from './dwg-filer.js';
import { CadDatabase } from './dwg-model.js';
import {
  CadLayerTableRecord,
  CadLine,
  CadCircle,
  CadArc,
  CadText,
  CadMText,
  CadLwPolyline,
  CadPoint,
  CadInsert,
  CadPolyline,
  CadVertex,
  CadXData,
  CadAcDbReactors,
  CadAcDbDictionary,
} from './dwg-model.js';

export type SvgConversionResult = {
  success: boolean;
  svgContent: string;
  width: number;
  height: number;
  entityCount: number;
  layerCount: number;
  error?: string;
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_STROKE_WIDTH = 0.5;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colorIndexToCss(colorIndex: number): string {
  // Basit bir Autodesk Color Index -> CSS renk eşlemesi
  const colors: Record<number, string> = {
    1: '#FF0000', // Kırmızı
    2: '#FFFF00', // Sarı
    3: '#00FF00', // Yeşil
    4: '#00FFFF', // Camgöbeği
    5: '#FF00FF', // Mor
    6: '#0000FF', // Mavi
    7: '#FFFFFF', // Beyaz
    8: '#000000', // Siyah
    9: '#808080', // Gri
    256: '#000000', // BYLAYER -> Siyah varsayılan
  };
  return colors[colorIndex] ?? '#000000';
}

@Injectable()
export class DwgSvgService {
  private readonly logger = new Logger(DwgSvgService.name);

  /**
   * DWG dosyasını SVG'ye dönüştürür.
   * Sadece belirli katmanlar istenirse onlar alınır; yoksa tüm katmanlar alınır.
   */
  async convertDwgToSvg(
    buffer: Buffer,
    options: {
      layers?: string[];
      monochrome?: boolean;
      paperWidth?: number;
      paperHeight?: number;
    } = {},
  ): Promise<SvgConversionResult> {
    const filer = new DwgFiler();
    let database: CadDatabase;

    try {
      database = filer.load(buffer);
    } catch (err) {
      this.logger.error(`DWG filer hata (SVG): ${err}`);
      throw new BadRequestException(
        `DWG dosyası okunamadı: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Seçili katmanlar varsa filtrele
    const selectedLayers = options.layers
      ? new Set(options.layers.map((l) => l.toLowerCase()))
      : null;

    // SVG elemanlarını topla
    const svgParts: string[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let entityCount = 0;

    database.accept({
      visitLayer: () => {},
      visitBlock: () => {},
      visitLine: (line) => {
        if (selectedLayers && !selectedLayers.has(line.layer.toLowerCase())) return;
        const stroke = options.monochrome ? '#000000' : colorIndexToCss(line.colorIndex);
        svgParts.push(
          `<line x1="${line.startX}" y1="${line.startY}" x2="${line.endX}" y2="${line.endY}" ` +
          `stroke="${escapeXml(stroke)}" stroke-width="${DEFAULT_STROKE_WIDTH}" />`,
        );
        minX = Math.min(minX, line.startX, line.endX);
        minY = Math.min(minY, line.startY, line.endY);
        maxX = Math.max(maxX, line.startX, line.endX);
        maxY = Math.max(maxY, line.startY, line.endY);
        entityCount++;
      },
      visitCircle: (circle) => {
        if (selectedLayers && !selectedLayers.has(circle.layer.toLowerCase())) return;
        const stroke = options.monochrome ? '#000000' : colorIndexToCss(circle.colorIndex);
        svgParts.push(
          `<circle cx="${circle.centerX}" cy="${circle.centerY}" r="${circle.radius}" ` +
          `fill="none" stroke="${escapeXml(stroke)}" stroke-width="${DEFAULT_STROKE_WIDTH}" />`,
        );
        minX = Math.min(minX, circle.centerX - circle.radius);
        minY = Math.min(minY, circle.centerY - circle.radius);
        maxX = Math.max(maxX, circle.centerX + circle.radius);
        maxY = Math.max(maxY, circle.centerY + circle.radius);
        entityCount++;
      },
      visitArc: (arc) => {
        if (selectedLayers && !selectedLayers.has(arc.layer.toLowerCase())) return;
        const stroke = options.monochrome ? '#000000' : colorIndexToCss(arc.colorIndex);
        const startRad = (arc.startAngle * Math.PI) / 180;
        const endRad = (arc.endAngle * Math.PI) / 180;
        const sx = arc.centerX + arc.radius * Math.cos(startRad);
        const sy = arc.centerY + arc.radius * Math.sin(startRad);
        const ex = arc.centerX + arc.radius * Math.cos(endRad);
        const ey = arc.centerY + arc.radius * Math.sin(endRad);
        const largeArc = Math.abs(endRad - startRad) > Math.PI ? 1 : 0;
        svgParts.push(
          `<path d="M ${sx} ${sy} A ${arc.radius} ${arc.radius} 0 ${largeArc} 0 ${ex} ${ey}" ` +
          `fill="none" stroke="${escapeXml(stroke)}" stroke-width="${DEFAULT_STROKE_WIDTH}" />`,
        );
        minX = Math.min(minX, sx, ex, arc.centerX - arc.radius);
        minY = Math.min(minY, sy, ey, arc.centerY - arc.radius);
        maxX = Math.max(maxX, sx, ex, arc.centerX + arc.radius);
        maxY = Math.max(maxY, sy, ey, arc.centerY + arc.radius);
        entityCount++;
      },
      visitText: (text) => {
        if (selectedLayers && !selectedLayers.has(text.layer.toLowerCase())) return;
        const stroke = options.monochrome ? '#000000' : colorIndexToCss(text.colorIndex);
        svgParts.push(
          `<text x="${text.insertX}" y="${text.insertY}" font-size="${text.height}" ` +
          `fill="${escapeXml(stroke)}" font-family="sans-serif">${escapeXml(text.value)}</text>`,
        );
        minX = Math.min(minX, text.insertX);
        minY = Math.min(minY, text.insertY);
        maxX = Math.max(maxX, text.insertX);
        maxY = Math.max(maxY, text.insertY);
        entityCount++;
      },
      visitMText: (mtext) => {
        if (selectedLayers && !selectedLayers.has(mtext.layer.toLowerCase())) return;
        const stroke = options.monochrome ? '#000000' : colorIndexToCss(mtext.colorIndex);
        svgParts.push(
          `<text x="${mtext.insertX}" y="${mtext.insertY}" font-size="${mtext.width || 10}" ` +
          `fill="${escapeXml(stroke)}" font-family="sans-serif">${escapeXml(mtext.value)}</text>`,
        );
        minX = Math.min(minX, mtext.insertX);
        minY = Math.min(minY, mtext.insertY);
        maxX = Math.max(maxX, mtext.insertX);
        maxY = Math.max(maxY, mtext.insertY);
        entityCount++;
      },
      visitLwPolyline: (poly) => {
        if (selectedLayers && !selectedLayers.has(poly.layer.toLowerCase())) return;
        const stroke = options.monochrome ? '#000000' : colorIndexToCss(poly.colorIndex);
        const points = poly.vertices.map(([x, y]) => `${x},${y}`).join(' ');
        svgParts.push(
          `<polyline points="${points}" fill="none" stroke="${escapeXml(stroke)}" ` +
          `stroke-width="${DEFAULT_STROKE_WIDTH}" />`,
        );
        for (const [x, y] of poly.vertices) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        entityCount++;
      },
      visitPoint: (point) => {
        if (selectedLayers && !selectedLayers.has(point.layer.toLowerCase())) return;
        const stroke = options.monochrome ? '#000000' : colorIndexToCss(point.colorIndex);
        svgParts.push(
          `<circle cx="${point.x}" cy="${point.y}" r="1" fill="${escapeXml(stroke)}" />`,
        );
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
        entityCount++;
      },
      visitInsert: (insert) => {
        if (selectedLayers && !selectedLayers.has(insert.layer.toLowerCase())) return;
        const stroke = options.monochrome ? '#000000' : colorIndexToCss(insert.colorIndex);
        svgParts.push(
          `<g transform="translate(${insert.insertX},${insert.insertY})" ` +
          `stroke="${escapeXml(stroke)}" stroke-width="${DEFAULT_STROKE_WIDTH}">` +
          `<rect x="-5" y="-5" width="10" height="10" fill="none" stroke="${escapeXml(stroke)}" />` +
          `<text x="0" y="0" font-size="4" fill="${escapeXml(stroke)}">${escapeXml(insert.blockName)}</text>` +
          `</g>`,
        );
        minX = Math.min(minX, insert.insertX - 5);
        minY = Math.min(minY, insert.insertY - 5);
        maxX = Math.max(maxX, insert.insertX + 5);
        maxY = Math.max(maxY, insert.insertY + 5);
        entityCount++;
      },
      visitPolyline: (polyline) => {
        if (selectedLayers && !selectedLayers.has(polyline.layer.toLowerCase())) return;
        const stroke = options.monochrome ? '#000000' : colorIndexToCss(polyline.colorIndex);
        const points = polyline.vertices.map(([x, y]) => `${x},${y}`).join(' ');
        svgParts.push(
          `<polyline points="${points}" fill="none" stroke="${escapeXml(stroke)}" ` +
          `stroke-width="${DEFAULT_STROKE_WIDTH}" />`,
        );
        for (const [x, y] of polyline.vertices) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        entityCount++;
      },
      visitVertex: (vertex) => {
        if (selectedLayers && !selectedLayers.has(vertex.layer.toLowerCase())) return;
        const stroke = options.monochrome ? '#000000' : colorIndexToCss(vertex.colorIndex);
        svgParts.push(
          `<circle cx="${vertex.x}" cy="${vertex.y}" r="0.8" fill="${escapeXml(stroke)}" />`,
        );
        minX = Math.min(minX, vertex.x);
        minY = Math.min(minY, vertex.y);
        maxX = Math.max(maxX, vertex.x);
        maxY = Math.max(maxY, vertex.y);
        entityCount++;
      },
      visitXData: (xdata) => {
        // XDATA görünür öğe değil, sadece meta veri olarak yorum
        svgParts.push(
          `<!-- XDATA app="${escapeXml(xdata.appName)}" codes="${xdata.codes.size}" -->`,
        );
      },
      visitAcDbReactors: (reactors) => {
        // Reaktörler görünür öğe değil, meta veri
        svgParts.push(
          `<!-- ACAD_REACTORS owner="${escapeXml(reactors.ownerHandle)}" count="${reactors.reactorHandles.length}" -->`,
        );
      },
      visitAcDbDictionary: (dictionary) => {
        // Sözlük görünür öğe değil, meta veri
        svgParts.push(
          `<!-- DICTIONARY name="${escapeXml(dictionary.name)}" entries="${dictionary.entries.size}" -->`,
        );
      },
    });

    if (entityCount === 0) {
      return {
        success: true,
        svgContent: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>',
        width: 100,
        height: 100,
        entityCount: 0,
        layerCount: 0,
      };
    }

    // Boşluk ekle (padding)
    const pad = 10;
    const viewBoxX = minX - pad;
    const viewBoxY = minY - pad;
    const viewBoxW = maxX - minX + 2 * pad;
    const viewBoxH = maxY - minY + 2 * pad;

    const width = options.paperWidth ?? viewBoxW;
    const height = options.paperHeight ?? viewBoxH;

    const svgContent = [
      `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="${viewBoxX} ${viewBoxY} ${viewBoxW} ${viewBoxH}">`,
      ...svgParts,
      '</svg>',
    ].join('\n');

    return {
      success: true,
      svgContent,
      width,
      height,
      entityCount,
      layerCount: selectedLayers ? selectedLayers.size : database.layers.size,
    };
  }

  /**
   * Dosya yolundan DWG'yi SVG'ye dönüştürür.
   */
  async convertDwgFileToSvg(
    filePath: string,
    options: {
      layers?: string[];
      monochrome?: boolean;
      paperWidth?: number;
      paperHeight?: number;
    } = {},
  ): Promise<SvgConversionResult> {
    if (!existsSync(filePath)) {
      throw new BadRequestException('DWG dosyası disk üzerinde bulunamadı.');
    }

    const buffer = await readFile(filePath);
    return this.convertDwgToSvg(buffer, options);
  }

  /**
   * Bellekteki buffer'ı SVG'ye dönüştürür (Multer upload sonrası).
   */
  async convertBufferToSvg(
    buffer: Buffer,
    options: {
      layers?: string[];
      monochrome?: boolean;
      paperWidth?: number;
      paperHeight?: number;
    } = {},
  ): Promise<SvgConversionResult> {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('DWG dosyası boş.');
    }

    return this.convertDwgToSvg(buffer, options);
  }
}
