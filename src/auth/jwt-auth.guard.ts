import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { verifyAccessToken } from './access-token.js';

export interface AuthenticatedUser {
  id: number;
}

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const [scheme, token, extra] = authorization?.split(' ') ?? [];

    if (scheme?.toLowerCase() !== 'bearer' || !token || extra) {
      throw new UnauthorizedException('A valid Bearer access token is required');
    }

    const claims = verifyAccessToken(token);
    if (!claims) throw new UnauthorizedException('Access token is invalid or expired');

    request.user = { id: claims.sub };
    return true;
  }
}
