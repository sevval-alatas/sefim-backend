import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ColumnAnalyzerService } from './column-analyzer.service.js';

const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

@Controller('column')
export class ColumnController {
  constructor(private readonly columnAnalyzerService: ColumnAnalyzerService) {}

  @Post('analyze')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMAGE_SIZE_BYTES, files: 1 },
      fileFilter: (_request, file, callback) => {
        const extension = file.originalname.toLowerCase().split('.').pop();
        const supportedExtension = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(
          extension ?? '',
        );
        callback(null, file.mimetype.startsWith('image/') || supportedExtension);
      },
    }),
  )
  analyze(@UploadedFile() file: Express.Multer.File, @Body() body: Record<string, string>) {
    if (!file) {
      throw new BadRequestException('An image is required in the "file" field');
    }

    return this.columnAnalyzerService.analyze(file, {
      referenceWidthPx: this.toNumber(body.referenceWidthPx),
      referenceWidthMm: this.toNumber(body.referenceWidthMm),
    });
  }

  private toNumber(value?: string) {
    const number = value === undefined ? undefined : Number(value);
    return number !== undefined && Number.isFinite(number) ? number : undefined;
  }
}