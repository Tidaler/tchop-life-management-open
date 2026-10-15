import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  type PasswordLoginInput,
  passwordLoginSchema,
  type PinLoginInput,
  pinLoginSchema,
} from '@tchop/shared';
import type { CookieOptions, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config.js';
import {
  type AppRequest,
  type AuthContext,
  CurrentAuth,
  CurrentDevice,
  type DeviceContext,
} from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AuthService, type ClientInfo } from './auth.service.js';
import { Authenticated, AuthRateLimited, Public, RequireDevice } from './decorators.js';
import { type IssuedTokens } from './tokens.service.js';

export const REFRESH_COOKIE = 'tchop_rt';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  @AuthRateLimited()
  async login(
    @Body(new ZodPipe(passwordLoginSchema)) body: PasswordLoginInput,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.passwordLogin(body, clientInfo(req)));
  }

  @Post('pin')
  @HttpCode(200)
  @Public()
  @RequireDevice()
  @AuthRateLimited()
  async pin(
    @Body(new ZodPipe(pinLoginSchema)) body: PinLoginInput,
    @CurrentDevice() device: DeviceContext,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.pinLogin(body, device, clientInfo(req)));
  }

  @Post('refresh')
  @HttpCode(200)
  @Public()
  async refresh(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    try {
      return this.respond(res, await this.auth.refresh(readRefreshCookie(req), req.device, clientInfo(req)));
    } catch (error) {
      res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(204)
  @Public()
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readRefreshCookie(req), req.auth, clientInfo(req));
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @Get('me')
  @Authenticated()
  me(@CurrentAuth() auth: AuthContext) {
    return this.auth.me(auth);
  }

  private respond(res: Response, issued: IssuedTokens) {
    res.cookie(REFRESH_COOKIE, issued.refreshToken, {
      ...this.cookieOptions(),
      expires: issued.refreshTokenExpiresAt,
    });
    return { accessToken: issued.accessToken, expiresIn: issued.accessTokenExpiresIn };
  }

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, secure: this.config.COOKIE_SECURE, sameSite: 'strict', path: '/api/auth' };
  }
}

function readRefreshCookie(req: AppRequest): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value ? value : undefined;
}

function clientInfo(req: AppRequest): ClientInfo {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}
