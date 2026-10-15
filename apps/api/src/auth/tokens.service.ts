import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { type Prisma } from '@tchop/db';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { newOpaqueToken, sha256 } from '../common/crypto.js';
import { PrismaService } from '../prisma.service.js';

export interface AccessTokenPayload {
  sub: string;
  tid: string;
  sid: string;
  sess: string;
  did?: string;
  m: 'password' | 'pin';
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionId: string;
}

export interface SessionInput {
  userId: string;
  tenantId: string;
  siteId: string;
  deviceId: string | null;
  method: 'password' | 'pin';
  familyId?: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class TokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Crée une session (jeton de rafraîchissement stocké sous forme d'empreinte) et un jeton d'accès court. */
  async issue(input: SessionInput, tx: Prisma.TransactionClient = this.prisma): Promise<IssuedTokens> {
    const refreshToken = newOpaqueToken();
    const refreshTokenExpiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_HOURS * 3_600_000);
    const session = await tx.authSession.create({
      data: {
        userId: input.userId,
        siteId: input.siteId,
        deviceId: input.deviceId,
        method: input.method,
        familyId: input.familyId ?? randomUUID(),
        refreshTokenHash: sha256(refreshToken),
        expiresAt: refreshTokenExpiresAt,
        ip: input.ip,
        userAgent: input.userAgent?.slice(0, 300),
      },
    });

    const payload: AccessTokenPayload = {
      sub: input.userId,
      tid: input.tenantId,
      sid: input.siteId,
      sess: session.id,
      m: input.method,
      ...(input.deviceId ? { did: input.deviceId } : {}),
    };
    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
    });

    return {
      accessToken,
      accessTokenExpiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshTokenExpiresAt,
      sessionId: session.id,
    };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
    try {
      return await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      return null;
    }
  }
}
