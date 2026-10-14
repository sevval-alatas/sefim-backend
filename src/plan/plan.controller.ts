import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { DwgColumnService } from './dwg-column.service.js';
import { isDwgFileName, requireDwgUpload } from './plan-upload-validation.js';

export const MAX_PLAN_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const plansDirectory = join(process.cwd(), 'uploads', 'plans');

@Controller('plans')
export class PlanController {
  constructor(private readonly dwgColumnService: DwgColumnService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_request, _file, callback) => {
          try {
            mkdirSync(plansDirectory, { recursive: true });
            callback(null, plansDirectory);
          } catch (error) {
            callback(error as Error, plansDirectory);
          }
        },
        filename: (_request, file, callback) => {
          callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`);
        },
      }),
      limits: { fileSize: MAX_PLAN_FILE_SIZE_BYTES, files: 1 },
      fileFilter: (_request, file, callback) => {
        callback(null, isDwgFileName(file.originalname));
      },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File) {
    const validFile = requireDwgUpload(file);
    const result = await this.dwgColumnService.extract(validFile.path);
    return {
      message: 'DWG işlendi',
      fileName: validFile.originalname,
      columnsFound: result.columns.length,
      columns: result.columns,
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
    };
  }
}
