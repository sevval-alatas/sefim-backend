import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import sharp from 'sharp';
import type { Sharp } from 'sharp';

type Calibration = {
  referenceWidthPx?: number;
  referenceWidthMm?: number;
};

type LineCandidate = {
  start: number;
  end: number;
  strength: number;
};

@Injectable()
export class ColumnAnalyzerService {
  async analyze(file: Express.Multer.File, calibration: Calibration = {}) {
    let image: Sharp;
    try {
      image = sharp(file.buffer, { failOn: 'error' });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error('Image dimensions are unavailable');
      }

      const { data, info } = await image
        .clone()
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const verticalCandidates = this.findCandidates(data, info.width, info.height, true);
      const horizontalCandidates = this.findCandidates(data, info.width, info.height, false);
      const pixelsPerMm = this.getPixelsPerMm(calibration);
      const imageScale = metadata.width / info.width;
      const diameterPx = this.averageThickness(verticalCandidates);
      const spacingPx = this.averageSpacing(horizontalCandidates);
      const verticalCount = verticalCandidates.length;
      const horizontalCount = horizontalCandidates.length;

      return {
        success: true,
        analysis: 'heuristic',
        estimated: true,
        bars: {
          verticalCount,
          horizontalCount,
        },
        verticalIronCount: verticalCount,
        horizontalIronCount: horizontalCount,
        image: {
          width: metadata.width,
          height: metadata.height,
          format: metadata.format,
        },
        rebar: {
          count: verticalCount,
          diameter: pixelsPerMm && diameterPx
            ? Number(((diameterPx * imageScale) / pixelsPerMm).toFixed(1))
            : null,
          diameterPx: diameterPx ? Number((diameterPx * imageScale).toFixed(1)) : null,
          confidence: this.confidence(verticalCount),
          candidates: verticalCandidates.map((candidate) => ({
            xStart: this.scale(candidate.start, info.width, metadata.width),
            xEnd: this.scale(candidate.end, info.width, metadata.width),
            strength: candidate.strength,
          })),
        },
        stirrups: {
          count: horizontalCount,
          diameter: null,
          spacing: pixelsPerMm && spacingPx
            ? Number(((spacingPx * imageScale) / pixelsPerMm).toFixed(1))
            : null,
          spacingPx: spacingPx ? Number((spacingPx * imageScale).toFixed(1)) : null,
          confidence: this.confidence(horizontalCount),
        },
        edge: {
          left: null,
          right: null,
          top: null,
          bottom: null,
          reason: pixelsPerMm
            ? 'Column boundary and rebar boundary require segmentation.'
            : 'A scale reference and column boundary are required for mm values.',
        },
        calibration: pixelsPerMm
          ? { pixelsPerMm, source: 'user-provided-reference' }
          : { pixelsPerMm: null, source: null },
        limitations: [
          'This is a contrast-based candidate detector, not an AI/model result.',
          'Diameter and cover are null until scale and column boundaries are known.',
          'Use a trained vision model for production-grade rebar and stirrup detection.',
        ],
      };
    } catch {
      throw new UnprocessableEntityException('The uploaded file is not a readable image');
    }
  }

  private findCandidates(data: Buffer, width: number, height: number, vertical: boolean) {
    const length = vertical ? width : height;
    const samples = vertical ? height : width;
    const values: number[] = [];

    for (let line = 0; line < length; line += 1) {
      let darkPixels = 0;
      for (let sample = 0; sample < samples; sample += 1) {
        const x = vertical ? line : sample;
        const y = vertical ? sample : line;
        if (data[y * width + x] < 75) darkPixels += 1;
      }
      values.push(darkPixels / samples);
    }

    const candidates: LineCandidate[] = [];
    let start = -1;
    for (let index = 0; index <= values.length; index += 1) {
      const isCandidate = index < values.length && values[index] >= 0.45;
      if (isCandidate && start < 0) start = index;
      if ((!isCandidate || index === values.length) && start >= 0) {
        if (index - start <= Math.max(12, Math.round(length * 0.04))) {
          const strength = values.slice(start, index).reduce((sum, value) => sum + value, 0) / (index - start);
          candidates.push({ start, end: index - 1, strength: Number(strength.toFixed(2)) });
        }
        start = -1;
      }
    }
    return candidates;
  }

  private getPixelsPerMm(calibration: Calibration) {
    if (!calibration.referenceWidthPx || !calibration.referenceWidthMm) return null;
    if (calibration.referenceWidthPx <= 0 || calibration.referenceWidthMm <= 0) return null;
    return calibration.referenceWidthPx / calibration.referenceWidthMm;
  }

  private scale(value: number, sourceWidth: number, targetWidth: number) {
    return Math.round((value * targetWidth) / sourceWidth);
  }

  private averageThickness(candidates: LineCandidate[]) {
    if (!candidates.length) return null;
    return Number(
      (candidates.reduce((sum, candidate) => sum + candidate.end - candidate.start + 1, 0) / candidates.length).toFixed(1),
    );
  }

  private averageSpacing(candidates: LineCandidate[]) {
    if (candidates.length < 2) return null;
    return Number(
      (candidates
        .slice(1)
        .map((candidate, index) => candidate.start - candidates[index].start)
        .reduce((sum, spacing) => sum + spacing, 0) /
        (candidates.length - 1)).toFixed(1),
    );
  }

  private confidence(count: number) {
    return count > 0 ? 0.2 : 0;
  }
}