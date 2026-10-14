import { Module } from '@nestjs/common';
import { CadController } from './cad.controller.js';
import { CadDrawingService } from './cad-drawing.service.js';
import { DwgConverterService } from './dwg-converter.service.js';

@Module({
  controllers: [CadController],
  providers: [DwgConverterService, CadDrawingService],
  exports: [DwgConverterService, CadDrawingService],
})
export class CadModule {}

