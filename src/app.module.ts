import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CadModule } from './cad/cad.module.js';

@Module({
  imports: [CadModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
