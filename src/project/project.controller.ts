import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard, type AuthenticatedUser } from '../auth/jwt-auth.guard.js';
import { ProjectService } from './project.service.js';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('santiye')
@UseGuards(JwtAuthGuard)
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  /** Lists this user's projects, including pending/rejected membership state. */
  @Get('me')
  getMyProjects(@Req() request: AuthenticatedRequest) {
    return this.projectService.getMyProjects(request.user.id);
  }

  /** Lists incoming pending membership requests as notifications. */
  @Get('notifications')
  getNotifications(@Req() request: AuthenticatedRequest) {
    return this.projectService.getNotifications(request.user.id);
  }

  /** Creates a project and makes its creator the active owner. */
  @Post()
  create(@Body() body: { name?: string; address?: string | null }, @Req() request: AuthenticatedRequest) {
    return this.projectService.create(request.user.id, body);
  }

  /** Requests membership using the project's registration code. */
  @Post('join-requests')
  requestToJoin(@Body() body: { code?: string }, @Req() request: AuthenticatedRequest) {
    return this.projectService.requestToJoin(request.user.id, body);
  }

  @Get(':projectId/join-requests')
  getJoinRequests(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
    return this.projectService.getJoinRequests(request.user.id, projectId);
  }

  @Patch(':projectId/join-requests/:memberId')
  reviewJoinRequest(
    @Param('projectId') projectId: string,
    @Param('memberId') memberId: string,
    @Body() body: { decision?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.projectService.reviewJoinRequest(request.user.id, projectId, memberId, body.decision ?? '');
  }
}
