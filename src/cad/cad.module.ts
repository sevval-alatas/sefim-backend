import { Module } from '@nestjs/common';
import { CadController } from './cad.controller.js';
import { CadDrawingService } from './cad-drawing.service.js';
import { DwgConverterService } from './dwg-converter.service.js';
import { DwgReaderController } from './dwg-reader.controller.js';
import { DwgReaderService } from './dwg-reader.service.js';
import { DwgNativeReaderService } from './dwg-native-reader.service.js';

@Module({
  controllers: [CadController, DwgReaderController],
  providers: [
    DwgConverterService,
    CadDrawingService,
    DwgReaderService,
    DwgNativeReaderService,
  ],
  exports: [
    DwgConverterService,
    CadDrawingService,
    DwgReaderService,
    DwgNativeReaderService,
  ],
})
export class CadModule {}

