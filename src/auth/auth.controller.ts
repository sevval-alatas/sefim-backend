import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import type { LoginRequest, SignupRequest } from './auth.types.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('signup')
  signup(@Body() body: SignupRequest) {
    return this.authService.signup(body);
  }

  @Post('login')
  login(@Body() body: LoginRequest) {
    return this.authService.login(body);
  }
}