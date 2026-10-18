/**
 * DWG'yi mobil uyumlu SVG'ye dönüştüren HTTP endpointleri.
 */

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
  ApiQuery,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { DwgSvgService } from './dwg-svg.service.js';
import { SvgConversionResult } from './dwg-svg.service.js';

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

@ApiTags('CAD SVG Conversion')
@Controller('api/cad/convert/svg')
export class DwgSvgController {
  constructor(private readonly dwgSvgService: DwgSvgService) {}

  @Post()
  @ApiOperation({
    summary: 'DWG dosyasını mobil uyumlu SVG formatına dönüştürür',
    description:
      'DWG dosyasını vektörel SVG formatına çevirir. Mobil cihazlarda hızlı render, ' +
      'küçük dosya boyutu ve sonsuz zoom sağlar. Varsayılan olarak tüm katmanlar dahil edilir; ' +
      'layers parametresi ile sadece belirli katmanlar seçilebilir.',
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
  @ApiQuery({
    name: 'layers',
    required: false,
    description: 'Sadece bu katmanların SVG\'e alınması (virgülle ayrılmış, ör: Kolon,Duvar)',
  })
  @ApiQuery({
    name: 'monochrome',
    required: false,
    type: Boolean,
    description: 'Siyah-beyaz yüksek kontrast modu',
  })
  @ApiQuery({
    name: 'paperWidth',
    required: false,
    type: Number,
    description: 'SVG genişliği (varsayılan: çizim sınırlarına göre otomatik)',
  })
  @ApiQuery({
    name: 'paperHeight',
    required: false,
    type: Number,
    description: 'SVG yüksekliği (varsayılan: çizim sınırlarına göre otomatik)',
  })
  @ApiResponse({ status: 200, description: 'SVG içeriği metin olarak döner.' })
  @ApiResponse({ status: 400, description: 'Geçersiz dosya veya DWG formatında değil.' })
  @ApiResponse({ status: 500, description: 'Sunucu tarafı dönüştürme hatası.' })
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
  async convertToSvg(
    @UploadedFile() file: Express.Multer.File,
    @ApiQuery() layers?: string,
    @ApiQuery() monochrome?: string,
    @ApiQuery() paperWidth?: string,
    @ApiQuery() paperHeight?: string,
  ): Promise<SvgConversionResult> {
    if (!file) {
      throw new BadRequestException('"file" alanında geçerli bir DWG dosyası yüklenmelidir.');
    }

    const layerList = layers ? layers.split(',').map((l) => l.trim()).filter(Boolean) : undefined;

    return this.dwgSvgService.convertBufferToSvg(file.buffer, {
      layers: layerList,
      monochrome: monochrome === 'true' || monochrome === '1',
      paperWidth: paperWidth ? parseFloat(paperWidth) : undefined,
      paperHeight: paperHeight ? parseFloat(paperHeight) : undefined,
    });
  }
}
