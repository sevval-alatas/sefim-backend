import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { db } from '../prisma/db.js';

@Injectable()
export class ProjectService {
  async getMyProjects(userId: number) {
    const memberships = await db.orm.public.ProjectMember
      .where({ userId })
      .include('project')
      .orderBy((membership) => membership.createdAt.desc())
      .all();

    return memberships.map(({ project, ...membership }) => ({
      ...project,
      membership: {
        id: membership.id,
        role: membership.role,
        status: membership.status,
        createdAt: membership.createdAt,
      },
    }));
  }

  async getNotifications(userId: number) {
    const memberships = await db.orm.public.ProjectMember
      .where({ userId, status: 'ACTIVE' })
      .include('project')
      .all();
    const managedProjects = memberships.filter(
      ({ role }) => role === 'OWNER' || role === 'ADMIN',
    );

    const requestsByProject = await Promise.all(
      managedProjects.map(async ({ project }) => {
        const requests = await db.orm.public.ProjectMember
          .where({ projectId: project.id, status: 'PENDING' })
          .include('user', (user) => user.select('id', 'name', 'username', 'email'))
          .orderBy((membership) => membership.createdAt.asc())
          .all();

        return requests.map(({ user, ...membership }) => {
          const applicant = user ?? {
            id: membership.userId,
            name: null,
            username: null,
            email: null,
          };
          const applicantName = applicant.name ?? applicant.username ?? applicant.email ?? 'Bir kullanıcı';

          return {
            id: membership.id,
            type: 'PROJECT_JOIN_REQUEST' as const,
            message: `${applicantName} şantiyeye katılmak istiyor`,
            project: { id: project.id, name: project.name },
            applicant,
            createdAt: membership.createdAt,
          };
        });
      }),
    );

    return requestsByProject.flat().sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt),
    );
  }

  async create(userId: number, input: { name?: string; address?: string | null }) {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Şantiye adı zorunludur');

    const project = await db.orm.public.Project.create({
      name,
      code: randomBytes(5).toString('hex').toUpperCase(),
      address: input.address?.trim() || null,
    });

    await db.orm.public.ProjectMember.create({
      userId,
      projectId: project.id,
      role: 'OWNER',
      status: 'ACTIVE',
    });

    return { ...project, membership: { role: 'OWNER', status: 'ACTIVE' } };
  }

  async requestToJoin(userId: number, input: { code?: string }) {
    const code = input.code?.trim().toUpperCase();
    if (!code) throw new BadRequestException('Şantiye kayıt kodu zorunludur');

    const project = await db.orm.public.Project.where({ code }).first();
    if (!project) throw new NotFoundException('Şantiye bulunamadı');

    const existing = await db.orm.public.ProjectMember
      .where({ userId, projectId: project.id })
      .first();
    if (existing) {
      if (existing.status === 'ACTIVE') throw new ConflictException('Bu şantiyenin zaten aktif üyesisiniz');
      if (existing.status === 'PENDING') throw new ConflictException('Katılım başvurunuz zaten bekliyor');
      return db.orm.public.ProjectMember.where({ id: existing.id }).update({ status: 'PENDING' });
    }

    return db.orm.public.ProjectMember.create({ userId, projectId: project.id });
  }

  async getJoinRequests(userId: number, projectId: string) {
    await this.assertManager(userId, projectId);
    return db.orm.public.ProjectMember
      .where({ projectId, status: 'PENDING' })
      .include('user', (user) => user.select('id', 'name', 'username', 'email'))
      .orderBy((membership) => membership.createdAt.asc())
      .all();
  }

  async reviewJoinRequest(userId: number, projectId: string, memberId: string, decision: string) {
    await this.assertManager(userId, projectId);
    if (decision !== 'ACTIVE' && decision !== 'REJECTED') {
      throw new BadRequestException('Karar ACTIVE veya REJECTED olmalıdır');
    }
    const request = await db.orm.public.ProjectMember
      .where({ id: memberId, projectId, status: 'PENDING' })
      .first();
    if (!request) throw new NotFoundException('Bekleyen katılım başvurusu bulunamadı');

    return db.orm.public.ProjectMember.where({ id: memberId }).update({ status: decision });
  }

  private async assertManager(userId: number, projectId: string) {
    const project = await db.orm.public.Project.where({ id: projectId }).first();
    if (!project) throw new NotFoundException('Şantiye bulunamadı');
    const membership = await db.orm.public.ProjectMember
      .where({ userId, projectId, status: 'ACTIVE' })
      .first();
    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
      throw new ForbiddenException('Bu işlem için şantiye yöneticisi olmalısınız');
    }
  }
}
