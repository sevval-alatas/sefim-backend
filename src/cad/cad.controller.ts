import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { existsSync } from 'node:fs';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CadDrawingService } from './cad-drawing.service.js';
import { DwgConverterService } from './dwg-converter.service.js';

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

@ApiTags('CAD Conversion & Storage')
@Controller(['api/cad', 'cad'])
export class CadController {
  constructor(
    private readonly dwgConverterService: DwgConverterService,
    private readonly cadDrawingService: CadDrawingService,
  ) {}

  @Get('status')
  @ApiOperation({
    summary: 'CAD dönüştürücü durumunu kontrol eder',
    description: 'Sistemde Vektörel PDF (QCAD dwg2pdf) ve DXF dönüştürücülerin durumunu raporlar.',
  })
  @ApiResponse({ status: 200, description: 'Dönüştürücü servis durumu' })
  async getStatus() {
    return this.dwgConverterService.checkConverterAvailable();
  }

  @Post('convert')
  @ApiOperation({
    summary: 'DWG dosyasını Vektörel PDF (varsayılan) veya DXF formatına dönüştürüp gönderir',
    description:
      'Mobil uygulama ve web görüntüleme için optimize edilmiştir. ' +
      'Varsayılan olarak (veya format=pdf) doğrudan Vektörel PDF dosyası indirilir (sonsuz zoom, 60 FPS, piksellenmeyen çizim). ' +
      'format=dxf verilirse DXF dosyası döner. ' +
      'format=json verilirse dosya indirme URL\'si içeren JSON yanıtı döner.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiProduces('application/pdf', 'application/dxf', 'application/json')
  @ApiQuery({
    name: 'format',
    required: false,
    enum: ['pdf', 'dxf', 'json'],
    description: 'Çıktı biçimi: "pdf" (varsayılan, doğrudan Vektörel PDF iner), "dxf" (DXF iner) veya "json" (indirme URL\'si döner)',
  })
  @ApiQuery({
    name: 'paper',
    required: false,
    enum: ['A0', 'A1', 'A2', 'A3', 'A4'],
    description: 'PDF pafta boyutu (varsayılan "A0" - statik projeler için büyük ve okunaklı metin sağlar)',
  })
  @ApiQuery({
    name: 'monochrome',
    required: false,
    type: Boolean,
    description: 'Siyah-beyaz yüksek kontrast modu',
  })
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
  @ApiResponse({
    status: 200,
    description: 'Dönüştürülen Vektörel PDF veya DXF dosyası doğrudan indirilir.',
  })
  @ApiResponse({ status: 400, description: 'Geçersiz dosya veya DWG formatında değil.' })
  @ApiResponse({ status: 502, description: 'Dönüştürme işlemi başarısız oldu.' })
  @ApiResponse({ status: 503, description: 'Dönüştürücü servisi geçici olarak meşgul.' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
      fileFilter: (_request, file, callback) => {
        const hasValidExt = /\.(dwg|dxf)$/i.test(file.originalname);
        if (!hasValidExt) {
          return callback(new BadRequestException('Sadece .dwg veya .dxf uzantılı CAD dosyaları kabul edilir.'), false);
        }
        callback(null, true);
      },
    }),
  )
  async convert(
    @UploadedFile() file: Express.Multer.File,
    @Res() response: Response,
    @Query('format') format?: string,
    @Query('paper') paper?: string,
    @Query('monochrome') monochrome?: string,
    @Query('deviceId') queryDeviceId?: string,
    @Headers('x-device-id') headerDeviceId?: string,
    @Body('deviceId') bodyDeviceId?: string,
  ) {
    if (!file) {
      throw new BadRequestException('"file" alanında geçerli bir CAD dosyası yüklenmelidir.');
    }

    const deviceId = (headerDeviceId || queryDeviceId || bodyDeviceId || 'anonymous-device').trim();

    // 1. Gelen DWG dosyasını uploads/cad kalıcı klasörüne ve veritabanına deviceId ile kaydet
    const drawing = await this.cadDrawingService.saveUploadedDrawing(file, deviceId);

    const pdfOptions = {
      paper: paper || 'A0',
      monochrome: monochrome === 'true' || monochrome === '1',
    };

    const targetFormat: 'auto' | 'dxf' | 'pdf' =
      format === 'dxf' ? 'dxf' : format === 'pdf' ? 'pdf' : 'auto';

    try {
      const result = await this.dwgConverterService.convert(file, targetFormat, pdfOptions);

      // 2. Dönüştürülen dosyayı kalıcı klasöre aktar ve veritabanını güncelle
      await this.cadDrawingService.markConversionSuccess(drawing.id, {
        convertedFormat: result.format,
        convertedFileName: result.fileName,
        tempOutputPath: result.outputPath,
      });

      // JSON formatı istendiyse indirme bağlantısıyla yanıt ver
      if (format === 'json') {
        return response.status(HttpStatus.OK).json({
          success: true,
          drawingId: drawing.id,
          deviceId,
          fileId: result.fileId,
          fileName: result.fileName,
          format: result.format,
          fallbackUsed: Boolean(result.fallbackUsed),
          strategyUsed: result.strategyUsed,
          downloadUrl: `/api/cad/drawings/${drawing.id}/download`,
          tempDownloadUrl: result.downloadUrl,
        });
      }

      // Varsayılan: Doğrudan dosyayı gönder (DXF veya PDF)
      const mimeType = result.format === 'pdf' ? 'application/pdf' : 'application/dxf';
      response.setHeader('Content-Type', mimeType);
      response.setHeader('X-CAD-Format', result.format);
      response.setHeader('X-Drawing-Id', drawing.id);
      response.setHeader('X-Device-Id', deviceId);
      if (result.fallbackUsed) {
        response.setHeader('X-CAD-Fallback', 'true');
      }
      response.setHeader(
        'Access-Control-Expose-Headers',
        'X-CAD-Format, X-CAD-Fallback, X-Drawing-Id, X-Device-Id, Content-Disposition',
      );
      response.download(result.outputPath, result.fileName, async (err) => {
        if (err) {
          // İndirme kesilmiş olabilir
        }
        await this.dwgConverterService.cleanup(result.fileId);
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.cadDrawingService.markConversionFailed(drawing.id, errorMsg);
      throw error;
    }
  }

  @Get('drawings')
  @ApiOperation({
    summary: 'Cihaza (deviceId) ait kayıtlı tüm CAD çizimlerini listeler',
    description: 'Verilen deviceId veya X-Device-Id başlığına göre kaydedilmiş DWG çizimlerini getirir.',
  })
  @ApiQuery({ name: 'deviceId', required: false, description: 'Cihaz ID' })
  async getDrawings(
    @Query('deviceId') queryDeviceId?: string,
    @Headers('x-device-id') headerDeviceId?: string,
  ) {
    const deviceId = (headerDeviceId || queryDeviceId || '').trim();
    if (!deviceId) {
      throw new BadRequestException('deviceId sorgu parametresi veya X-Device-Id başlığı zorunludur.');
    }
    return this.cadDrawingService.getDrawingsByDeviceId(deviceId);
  }

  @Get('drawings/:id')
  @ApiOperation({ summary: 'Kayıtlı bir CAD çiziminin detaylarını getirir' })
  @ApiParam({ name: 'id', description: 'Çizim ID (UUID)' })
  async getDrawingDetails(@Param('id') id: string) {
    const drawing = await this.cadDrawingService.getDrawingById(id);
    if (!drawing) {
      throw new NotFoundException(`Çizim bulunamadı [ID: ${id}]`);
    }
    return this.cadDrawingService.toResponseDto(drawing);
  }

  @Get('drawings/:id/download')
  @ApiOperation({ summary: 'Kayıtlı çizimin dönüştürülmüş (DXF/PDF) veya orijinal DWG dosyasını indirir' })
  @ApiParam({ name: 'id', description: 'Çizim ID (UUID)' })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['converted', 'original'],
    description: 'İndirilecek dosya türü ("converted" veya "original")',
  })
  async downloadSavedDrawing(
    @Param('id') id: string,
    @Res() response: Response,
    @Query('type') type?: string,
  ) {
    const drawing = await this.cadDrawingService.getDrawingById(id);
    if (!drawing) {
      throw new NotFoundException(`Çizim bulunamadı [ID: ${id}]`);
    }

    const isOriginal = type === 'original';
    const filePath = isOriginal ? drawing.originalFilePath : (drawing.convertedFilePath || drawing.originalFilePath);
    const fileName = isOriginal ? drawing.originalFileName : (drawing.convertedFileName || drawing.originalFileName);

    if (!filePath || !existsSync(filePath)) {
      throw new NotFoundException('İstenen dosya disk üzerinde bulunamadı.');
    }

    const mimeType = isOriginal
      ? 'application/acad'
      : drawing.convertedFormat === 'pdf'
        ? 'application/pdf'
        : 'application/dxf';

    response.setHeader('Content-Type', mimeType);
    response.setHeader('X-Drawing-Id', drawing.id);
    response.setHeader('X-Device-Id', drawing.deviceId);
    if (drawing.convertedFormat) {
      response.setHeader('X-CAD-Format', drawing.convertedFormat);
    }
    response.download(filePath, fileName);
  }

  @Delete('drawings/:id')
  @ApiOperation({ summary: 'Kayıtlı bir CAD çizimini ve dosyalarını siler' })
  @ApiParam({ name: 'id', description: 'Çizim ID (UUID)' })
  @ApiQuery({ name: 'deviceId', required: false, description: 'Cihaz ID doğrulama için' })
  async deleteDrawing(
    @Param('id') id: string,
    @Query('deviceId') queryDeviceId?: string,
    @Headers('x-device-id') headerDeviceId?: string,
  ) {
    const deviceId = (headerDeviceId || queryDeviceId || '').trim();
    await this.cadDrawingService.deleteDrawing(id, deviceId || undefined);
    return { success: true, message: 'Çizim ve ilişkili dosyalar başarıyla silindi.' };
  }

  @Post('convert/pdf')
  @ApiOperation({
    summary: 'DWG dosyasını doğrudan Vektörel PDF formatına dönüştürüp gönderir',
    description: 'Statik ve mimari projeler için A0 pafta boyutunda, ince çizgili, 2D düzleştirilmiş Vektörel PDF üretir.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiProduces('application/pdf')
  @ApiQuery({
    name: 'paper',
    required: false,
    enum: ['A0', 'A1', 'A2', 'A3', 'A4'],
    description: 'PDF pafta boyutu (varsayılan "A0")',
  })
  @ApiQuery({
    name: 'monochrome',
    required: false,
    type: Boolean,
    description: 'Siyah-beyaz modu',
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
      fileFilter: (_request, file, callback) => {
        callback(null, /\.(dwg|dxf)$/i.test(file.originalname));
      },
    }),
  )
  async convertToPdf(
    @UploadedFile() file: Express.Multer.File,
    @Res() response: Response,
    @Query('paper') paper?: string,
    @Query('monochrome') monochrome?: string,
    @Query('deviceId') queryDeviceId?: string,
    @Headers('x-device-id') headerDeviceId?: string,
  ) {
    if (!file) {
      throw new BadRequestException('"file" alanında geçerli bir CAD dosyası yüklenmelidir.');
    }
    const deviceId = (headerDeviceId || queryDeviceId || 'anonymous-device').trim();
    const drawing = await this.cadDrawingService.saveUploadedDrawing(file, deviceId);

    const pdfOptions = {
      paper: paper || 'A0',
      monochrome: monochrome === 'true' || monochrome === '1',
    };
    try {
      const result = await this.dwgConverterService.convertToPdf(file, pdfOptions);
      await this.cadDrawingService.markConversionSuccess(drawing.id, {
        convertedFormat: 'pdf',
        convertedFileName: result.fileName,
        tempOutputPath: result.outputPath,
      });

      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader('X-CAD-Format', 'pdf');
      response.setHeader('X-Drawing-Id', drawing.id);
      response.setHeader('X-Device-Id', deviceId);
      response.download(result.outputPath, result.fileName, async () => {
        await this.dwgConverterService.cleanup(result.fileId);
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.cadDrawingService.markConversionFailed(drawing.id, errorMsg);
      throw error;
    }
  }

  @Post('convert/dxf')
  @ApiOperation({ summary: 'DWG dosyasını DXF formatına dönüştürüp gönderir' })
  @ApiConsumes('multipart/form-data')
  @ApiProduces('application/dxf')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
      fileFilter: (_request, file, callback) => {
        callback(null, /\.dwg$/i.test(file.originalname));
      },
    }),
  )
  async convertToDxf(
    @UploadedFile() file: Express.Multer.File,
    @Res() response: Response,
    @Query('deviceId') queryDeviceId?: string,
    @Headers('x-device-id') headerDeviceId?: string,
  ) {
    if (!file) {
      throw new BadRequestException('"file" alanında geçerli bir .dwg dosyası yüklenmelidir.');
    }
    const deviceId = (headerDeviceId || queryDeviceId || 'anonymous-device').trim();
    const drawing = await this.cadDrawingService.saveUploadedDrawing(file, deviceId);

    try {
      const result = await this.dwgConverterService.convertToDxf(file);
      await this.cadDrawingService.markConversionSuccess(drawing.id, {
        convertedFormat: 'dxf',
        convertedFileName: result.fileName,
        tempOutputPath: result.outputPath,
      });

      response.setHeader('Content-Type', 'application/dxf');
      response.setHeader('X-CAD-Format', 'dxf');
      response.setHeader('X-Drawing-Id', drawing.id);
      response.setHeader('X-Device-Id', deviceId);
      response.download(result.outputPath, result.fileName, async () => {
        await this.dwgConverterService.cleanup(result.fileId);
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.cadDrawingService.markConversionFailed(drawing.id, errorMsg);
      throw error;
    }
  }

  @Get('files/:fileId')
  @ApiOperation({ summary: 'Daha önce dönüştürülmüş dosyayı fileId ile indirir' })
  @ApiParam({ name: 'fileId', description: 'Dönüştürme işleminden dönen fileId' })
  async download(@Param('fileId') fileId: string, @Res() response: Response) {
    const file = await this.dwgConverterService.getConvertedFile(fileId);
    response.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    response.download(file.path, file.name);
  }
}