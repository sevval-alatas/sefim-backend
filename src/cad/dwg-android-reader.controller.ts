import {
  Controller,
  Post,
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
import { DwgAndroidBridgeService } from './dwg-android-bridge.service.js';
import type { AndroidDwgReaderResult } from './dwg-android-bridge.service.js';

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

@ApiTags('CAD Android DWG Reader')
@Controller('api/cad/read/android')
export class DwgAndroidReaderController {
  constructor(private readonly dwgAndroidBridgeService: DwgAndroidBridgeService) {}

  @Post()
  @ApiOperation({ summary: 'Android .so tabanlı DWG okuyucu ile dosyayı okur' })
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
  @ApiResponse({ status: 503, description: 'Android DWG bridge mevcut değil.' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
      fileFilter: (_request, file, callback) => {
        const hasValidExt = /\.dwg$/i.test(file.originalname);
        if (!hasValidExt) {
          return callback(new BadRequestException('Sadece .dwg uzantılı CAD dosyaları kabul edilir.'), false);
        }
        callback(null, true);
      },
    }),
  )
  async readDwgAndroid(@UploadedFile() file: Express.Multer.File): Promise<AndroidDwgReaderResult> {
    if (!file) {
      throw new BadRequestException('"file" alanında geçerli bir DWG dosyası yüklenmelidir.');
    }
    return this.dwgAndroidBridgeService.readDwg(file.buffer, file.originalname);
  }
}
