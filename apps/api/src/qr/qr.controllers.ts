import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { qrRejectSchema, type QrRejectInput, qrSubmitSchema, type QrSubmitInput } from '@tchop/shared';
import type { CookieOptions, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { Public, PublicOrderRateLimited, PublicRateLimited, RequirePermission } from '../auth/decorators.js';
import { newOpaqueToken } from '../common/crypto.js';
import { type AppRequest, type AuthContext, CurrentAuth } from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { QrRequestsService } from './qr-requests.service.js';

/** Cookie anonyme du client : il relie ses demandes à son navigateur, sans rien savoir de lui. */
export const QR_CLIENT_COOKIE = 'tchop_qr';
const CLIENT_COOKIE_MAX_AGE_MS = 6 * 3_600_000;

/**
 * Menu public ouvert par le QR code d'une table. Aucune authentification : le jeton du QR code
 * donne accès au menu de cette table et à l'envoi de demandes, rien d'autre.
 */
@Controller('public/menu/:token')
export class PublicMenuController {
  constructor(
    private readonly qr: QrRequestsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @Public()
  @PublicRateLimited()
  async menu(@Param('token') token: string, @Res({ passthrough: true }) res: Response) {
    // Disponibilités en direct : pas de cache.
    res.setHeader('Cache-Control', 'no-store');
    return this.qr.menu(token);
  }

  @Get('orders')
  @Public()
  @PublicRateLimited()
  async myOrders(
    @Param('token') token: string,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.qr.clientRequests(token, readClientCookie(req));
  }

  @Post('orders')
  @HttpCode(201)
  @Public()
  @PublicOrderRateLimited()
  async submit(
    @Param('token') token: string,
    @Body(new ZodPipe(qrSubmitSchema)) body: QrSubmitInput,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    let client = readClientCookie(req);
    if (!client) {
      client = newOpaqueToken();
      res.cookie(QR_CLIENT_COOKIE, client, this.cookieOptions());
    }
    res.setHeader('Cache-Control', 'no-store');
    return this.qr.submit(token, client, body);
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'strict',
      path: '/api/public',
      maxAge: CLIENT_COOKIE_MAX_AGE_MS,
    };
  }
}

/** Demandes QR à valider par le personnel. */
@Controller('qr-requests')
export class QrRequestsController {
  constructor(private readonly qr: QrRequestsService) {}

  @Get()
  @RequirePermission('qr_request.handle', 'read')
  list(@CurrentAuth() auth: AuthContext) {
    return this.qr.listPending(auth);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequirePermission('qr_request.handle')
  accept(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.qr.accept(auth, id);
  }

  @Post(':id/reject')
  @HttpCode(204)
  @RequirePermission('qr_request.handle')
  async reject(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(qrRejectSchema)) body: QrRejectInput,
  ): Promise<void> {
    await this.qr.reject(auth, id, body);
  }
}

function readClientCookie(req: AppRequest): string | undefined {
  const value: unknown = req.cookies?.[QR_CLIENT_COOKIE];
  // Valeur attendue : 32 octets en base64url. Toute autre valeur est ignorée (un nouveau cookie est posé).
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
