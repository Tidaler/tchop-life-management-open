import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can } from '@tchop/shared';
import { sha256 } from '../common/crypto.js';
import { type AppRequest } from '../common/request-context.js';
import { PrismaService } from '../prisma.service.js';
import { AccessService } from './access.service.js';
import { ACCESS_POLICY, type AccessPolicy, DEVICE_REQUIRED, DEVICE_TOKEN_HEADER } from './decorators.js';
import { TokensService } from './tokens.service.js';

const DEVICE_SEEN_REFRESH_MS = 60_000;

/**
 * Garde globale : identifie l'appareil et l'utilisateur, puis applique la politique d'accès de la route.
 * Toute route sans politique déclarée est refusée.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_POLICY, targets);
    const deviceRequired = this.reflector.getAllAndOverride<boolean | undefined>(DEVICE_REQUIRED, targets);
    const req = context.switchToHttp().getRequest<AppRequest>();

    if (!policy) {
      throw new ForbiddenException({ code: 'NO_ACCESS_POLICY', message: "Route sans politique d'accès" });
    }

    await this.identifyDevice(req);
    if (deviceRequired && !req.device) {
      throw new UnauthorizedException({ code: 'DEVICE_REQUIRED', message: 'Appareil non enregistré' });
    }

    if (policy.kind === 'public') return true;

    await this.authenticate(req);
    if (policy.kind === 'permission' && !can(req.auth!.grants, policy.permission, policy.access)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: "Vous n'avez pas le droit d'effectuer cette action",
      });
    }
    return true;
  }

  private async identifyDevice(req: AppRequest): Promise<void> {
    const token = req.header(DEVICE_TOKEN_HEADER);
    if (!token) return;
    const device = await this.prisma.device.findUnique({ where: { tokenHash: sha256(token) } });
    if (!device || device.revokedAt) {
      throw new UnauthorizedException({
        code: 'DEVICE_REVOKED',
        message: "Cet appareil n'est plus autorisé",
      });
    }
    req.device = { id: device.id, siteId: device.siteId, name: device.name };
    if (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > DEVICE_SEEN_REFRESH_MS) {
      await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
    }
  }

  private async authenticate(req: AppRequest): Promise<void> {
    const header = req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const payload = token ? await this.tokens.verifyAccessToken(token) : null;
    if (!payload) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Connexion requise' });
    }

    // Une session ouverte par PIN n'est valable que sur l'appareil qui l'a ouverte.
    if (payload.did && payload.did !== req.device?.id) {
      throw new UnauthorizedException({
        code: 'DEVICE_MISMATCH',
        message: 'Session liée à un autre appareil',
      });
    }

    const session = await this.prisma.authSession.findUnique({
      where: { id: payload.sess },
      include: { user: { select: { active: true } } },
    });
    if (!session || session.revokedAt || !session.user.active) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        message: 'Session expirée, reconnectez-vous',
      });
    }

    const role = await this.access.resolveRole(payload.sub, payload.sid);
    if (!role) throw new ForbiddenException({ code: 'NO_ACCESS_TO_SITE', message: 'Aucun rôle sur ce site' });

    req.auth = {
      userId: payload.sub,
      tenantId: payload.tid,
      siteId: payload.sid,
      sessionId: payload.sess,
      deviceId: payload.did ?? null,
      method: payload.m,
      roleCode: role.roleCode,
      grants: role.grants,
    };
  }
}
