import sharp from 'sharp';
import { ColumnAnalyzerService } from './column-analyzer.service';

describe('ColumnAnalyzerService', () => {
  it('returns an estimated analysis for a readable image', async () => {
    const buffer = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();
    const service = new ColumnAnalyzerService();

    const result = await service.analyze({ buffer } as Express.Multer.File, {
      referenceWidthPx: 320,
      referenceWidthMm: 300,
    });

    expect(result.success).toBe(true);
    expect(result.estimated).toBe(true);
    expect(result.bars).toEqual({ verticalCount: 0, horizontalCount: 0 });
    expect(result.verticalIronCount).toBe(0);
    expect(result.horizontalIronCount).toBe(0);
    expect(result.image.width).toBe(32);
    expect(result.calibration.pixelsPerMm).toBeCloseTo(1.0667, 3);
    expect(result.edge.left).toBeNull();
  });

  it('rejects non-image input', async () => {
    const service = new ColumnAnalyzerService();

    await expect(service.analyze({ buffer: Buffer.from('not an image') } as Express.Multer.File))
      .rejects.toThrow('The uploaded file is not a readable image');
  });
});