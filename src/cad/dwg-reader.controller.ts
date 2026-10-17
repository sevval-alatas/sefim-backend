/**
 * DWG okuması için HTTP endpointleri.
 */

import {
  Controller,
  Post,
  Get,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  ApiTags,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiBody,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { DwgReaderService } from './dwg-reader.service.js';
import { DwgNativeReaderService } from './dwg-native-reader.service.js';
import { DwgReaderResult } from './dwg-reader.service.js';
import { NativeReadResult } from './dwg-native-reader.service.js';

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

@ApiTags('CAD DWG Reader')
@Controller('api/cad/read')
export class DwgReaderController {
  constructor(
    private readonly dwgReaderService: DwgReaderService,
    private readonly dwgNativeReaderService: DwgNativeReaderService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'DWG okuyucu worker durumunu kontrol eder' })
  @ApiResponse({ status: 200, description: 'Worker durumu' })
  async getStatus() {
    return this.dwgReaderService.checkWorkerAvailable();
  }

  @Post('python')
  @ApiOperation({
    summary: 'DWG dosyasındaki tüm nesneleri Python worker ile okur',
    description: 'ezdwg / ezdxf tabanlı Python worker üzerinden tüm katmanlardaki tüm nesneleri JSON olarak döndürür.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: '.dwg uzantılı CAD çizim dosyası (maks. 100 MB)',
        },
      },
      required: ['file'],
    },
  })
  @ApiResponse({ status: 200, description: 'DWG nesneleri JSON olarak döner.' })
  @ApiResponse({ status: 400, description: 'Geçersiz dosya veya DWG formatında değil.' })
  @ApiResponse({ status: 500, description: 'Sunucu tarafı okuma hatası.' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
      fileFilter: (_request, file, callback) => {
        const hasValidExt = /\.(dwg)$/i.test(file.originalname);
        if (!hasValidExt) {
          return callback(new BadRequestException('Sadece .dwg uzantılı CAD dosyaları kabul edilir.'), false);
        }
        callback(null, true);
      },
    }),
  )
  async readDwgPython(@UploadedFile() file: Express.Multer.File): Promise<DwgReaderResult> {
    if (!file) {
      throw new BadRequestException('"file" alanında geçerli bir DWG dosyası yüklenmelidir.');
    }
    return this.dwgReaderService.readUploadedFile(file.buffer, file.originalname);
  }

  @Post('native')
  @ApiOperation({
    summary: 'DWG dosyasını native TypeScript reader ile okur ve DXF üretir',
    description: 'Katman A (parser), Katman B (model), Katman C (filer), Katman D (renderer) zinciriyle DWG dosyasını işler ve DXF çıktısı üretir.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: '.dwg uzantılı CAD çizim dosyası (maks. 100 MB)',
        },
      },
      required: ['file'],
    },
  })
  @ApiResponse({ status: 200, description: 'DWG DXF çıktısı ve özet döner.' })
  @ApiResponse({ status: 400, description: 'Geçersiz dosya veya DWG formatında değil.' })
  @ApiResponse({ status: 500, description: 'Sunucu tarafı okuma hatası.' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
      fileFilter: (_request, file, callback) => {
        const hasValidExt = /\.(dwg)$/i.test(file.originalname);
        if (!hasValidExt) {
          return callback(new BadRequestException('Sadece .dwg uzantılı CAD dosyaları kabul edilir.'), false);
        }
        callback(null, true);
      },
    }),
  )
  async readDwgNative(@UploadedFile() file: Express.Multer.File): Promise<NativeReadResult> {
    if (!file) {
      throw new BadRequestException('"file" alanında geçerli bir DWG dosyası yüklenmelidir.');
    }
    return this.dwgNativeReaderService.readBuffer(file.buffer);
  }
}
