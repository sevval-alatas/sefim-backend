import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ProjectController } from './project.controller.js';
import { ProjectService } from './project.service.js';

@Module({
  controllers: [ProjectController],
  providers: [ProjectService, JwtAuthGuard],
})
export class ProjectModule {}
