import { Module } from '@nestjs/common';
import { CadController } from './cad.controller.js';
import { CadDrawingService } from './cad-drawing.service.js';
import { DwgConverterService } from './dwg-converter.service.js';
import { DwgReaderController } from './dwg-reader.controller.js';
import { DwgReaderService } from './dwg-reader.service.js';
import { DwgNativeReaderService } from './dwg-native-reader.service.js';
import { DwgSvgController } from './dwg-svg.controller.js';
import { DwgSvgService } from './dwg-svg.service.js';
import { DwgAndroidReaderController } from './dwg-android-reader.controller.js';
import { DwgAndroidBridgeService } from './dwg-android-bridge.service.js';

@Module({
  controllers: [CadController, DwgReaderController, DwgSvgController, DwgAndroidReaderController],
  providers: [
    DwgConverterService,
    CadDrawingService,
    DwgReaderService,
    DwgNativeReaderService,
    DwgSvgService,
    DwgAndroidBridgeService,
  ],
  exports: [
    DwgConverterService,
    CadDrawingService,
    DwgReaderService,
    DwgNativeReaderService,
    DwgSvgService,
    DwgAndroidBridgeService,
  ],
})
export class CadModule {}

