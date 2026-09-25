import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { DwgConverterService } from './dwg-converter.service.js';

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

@Controller('api/cad')
export class CadController {
  constructor(private readonly dwgConverterService: DwgConverterService) {}

  @Post('convert')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
      fileFilter: (_request, file, callback) => {
        callback(null, /^\.dwg$/i.test(file.originalname.slice(file.originalname.lastIndexOf('.'))));
      },
    }),
  )
  convert(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('A .dwg file is required in the "file" field');
    }
    return this.dwgConverterService.convert(file);
  }

  @Get('files/:fileId')
  async download(@Param('fileId') fileId: string, @Res() response: Response) {
    const file = await this.dwgConverterService.getConvertedFile(fileId);
    response.download(file.path, file.name);
  }
}