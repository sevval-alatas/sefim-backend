import { Module } from '@nestjs/common';
import { PlanController } from './plan.controller.js';
import { DwgColumnService } from './dwg-column.service.js';

@Module({
  controllers: [PlanController],
  providers: [DwgColumnService],
})
export class PlanModule {}
