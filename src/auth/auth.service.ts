import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from '../prisma/db.js';
import { createAccessToken } from './access-token.js';
import type { LoginRequest, SignupRequest } from './auth.types.js';

const scrypt = promisify(scryptCallback);

@Injectable()
export class AuthService {
  async signup(input: SignupRequest) {
    const email = this.normalizeEmail(input.email);
    this.validateCredentials(email, input.password);

    const existingUser = await db.orm.public.User.where({ email }).first();
    if (existingUser) {
      throw new ConflictException('This email is already registered');
    }

    const passwordHash = await this.hashPassword(input.password);
    const user = await db.orm.public.User.create({
      email,
      passwordHash,
      username: input.username ?? null,
      name: input.name ?? null,
    });

    return this.authResponse(user);
  }

  async login(input: LoginRequest) {
    const email = this.normalizeEmail(input.email);
    this.validateCredentials(email, input.password);
    const user = await db.orm.public.User.where({ email }).first();

    if (!user || !(await this.verifyPassword(input.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.authResponse(user);
  }

  private authResponse(user: { id: number; email: string; username: string | null; name: string | null }) {
    return {
      accessToken: this.createToken(user.id),
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
      },
    };
  }

  private async hashPassword(password: string) {
    const salt = randomBytes(16).toString('hex');
    const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
    return `${salt}:${derivedKey.toString('hex')}`;
  }

  private async verifyPassword(password: string, storedHash: string) {
    const [salt, key] = storedHash.split(':');
    if (!salt || !key) return false;

    const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
    const storedKey = Buffer.from(key, 'hex');
    return storedKey.length === derivedKey.length && timingSafeEqual(storedKey, derivedKey);
  }

  private createToken(userId: number) {
    return createAccessToken(userId);
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private validateCredentials(email: string, password: string) {
    if (!email || !email.includes('@') || password.length < 8) {
      throw new UnauthorizedException('A valid email and password of at least 8 characters are required');
    }
  }
}
