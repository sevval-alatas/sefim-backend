import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CadController } from './cad/cad.controller.js';
import { DwgConverterService } from './cad/dwg-converter.service.js';
import { ColumnController } from './column/column.controller.js';
import { ColumnAnalyzerService } from './column/column-analyzer.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { DeliveryNoteModule } from './delivery-note/delivery-note.module.js';
import { ProjectModule } from './project/project.module.js';

@Module({
  imports: [DeliveryNoteModule, ProjectModule],
  controllers: [AppController, CadController, ColumnController, AuthController],
  providers: [AppService, DwgConverterService, ColumnAnalyzerService, AuthService],
})
export class AppModule {}
