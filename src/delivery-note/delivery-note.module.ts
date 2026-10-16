import { Module } from '@nestjs/common';
import { DeliveryNoteController } from './delivery-note.controller.js';
import { DeliveryNoteService } from './delivery-note.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';

@Module({
  controllers: [DeliveryNoteController],
  providers: [DeliveryNoteService, JwtAuthGuard]
})
export class DeliveryNoteModule {}
