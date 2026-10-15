import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { type PasswordLoginInput, type PinLoginInput } from '@tchop/shared';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { AuditService } from '../audit/audit.service.js';
import { sha256 } from '../common/crypto.js';
import { type AuthContext, type DeviceContext } from '../common/request-context.js';
import { PrismaService } from '../prisma.service.js';
import { AccessService } from './access.service.js';
import { verifySecret } from './password.js';
import { type IssuedTokens, TokensService } from './tokens.service.js';

export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 5;

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

const invalidCredentials = () =>
  new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Identifiant ou code incorrect' });
const invalidSession = () =>
  new UnauthorizedException({ code: 'SESSION_INVALID', message: 'Session expirée, reconnectez-vous' });

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Connexion par identifiant et mot de passe. */
  async passwordLogin(input: PasswordLoginInput, client: ClientInfo): Promise<IssuedTokens> {
    const { tenantId, siteId: requestedSiteId } = await this.resolveTenant(input);
    const user = await this.prisma.user.findUnique({
      where: { tenantId_username: { tenantId, username: input.username } },
    });

    const ok = await verifySecret(user?.active ? user.passwordHash : null, input.password);
    if (!user || !ok) {
      await this.audit.log({
        tenantId,
        siteId: requestedSiteId,
        actorId: user?.id,
        action: 'auth.login_failed',
        after: { method: 'password', username: input.username },
        ip: client.ip,
      });
      throw invalidCredentials();
    }

    const siteId = requestedSiteId ?? (await this.defaultSiteFor(user.id, tenantId));
    await this.assertSiteAccess(user.id, tenantId, siteId);

    return this.prisma.$transaction(async (tx) => {
      const issued = await this.tokens.issue(
        { userId: user.id, tenantId, siteId, deviceId: null, method: 'password', ...client },
        tx,
      );
      await this.audit.log(
        {
          tenantId,
          siteId,
          actorId: user.id,
          action: 'auth.login',
          after: { method: 'password' },
          ip: client.ip,
        },
        tx,
      );
      return issued;
    });
  }

  /** Connexion rapide par PIN, uniquement depuis un appareil enregistré du site. */
  async pinLogin(input: PinLoginInput, device: DeviceContext, client: ClientInfo): Promise<IssuedTokens> {
    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: device.siteId } });
    const user = await this.prisma.user.findFirst({
      where: { id: input.userId, tenantId: site.tenantId, active: true },
    });
    const base = { tenantId: site.tenantId, siteId: site.id, deviceId: device.id, ip: client.ip };

    if (user?.pinLockedUntil && user.pinLockedUntil > new Date()) {
      const retryAfter = Math.ceil((user.pinLockedUntil.getTime() - Date.now()) / 1000);
      throw new HttpException(
        { code: 'PIN_LOCKED', message: 'Trop de tentatives, réessayez plus tard', retryAfter },
        HttpStatus.LOCKED,
      );
    }

    const ok = await verifySecret(user?.pinHash, input.pin);
    if (!user || !ok) {
      if (user) await this.registerPinFailure(user.id, user.pinFailedCount, base);
      else await this.audit.log({ ...base, action: 'auth.login_failed', after: { method: 'pin' } });
      throw invalidCredentials();
    }

    await this.assertSiteAccess(user.id, site.tenantId, site.id);

    return this.prisma.$transaction(async (tx) => {
      if (user.pinFailedCount > 0 || user.pinLockedUntil) {
        await tx.user.update({ where: { id: user.id }, data: { pinFailedCount: 0, pinLockedUntil: null } });
      }
      const issued = await this.tokens.issue(
        {
          userId: user.id,
          tenantId: site.tenantId,
          siteId: site.id,
          deviceId: device.id,
          method: 'pin',
          ...client,
        },
        tx,
      );
      await this.audit.log({ ...base, actorId: user.id, action: 'auth.login', after: { method: 'pin' } }, tx);
      return issued;
    });
  }

  /**
   * Échange un jeton de rafraîchissement contre une nouvelle paire de jetons (rotation).
   * Un jeton déjà utilisé révèle un vol possible : toute la famille de sessions est révoquée.
   */
  async refresh(refreshToken: string | undefined, device: DeviceContext | undefined, client: ClientInfo) {
    if (!refreshToken) throw invalidSession();
    const session = await this.prisma.authSession.findUnique({
      where: { refreshTokenHash: sha256(refreshToken) },
      include: { user: true },
    });
    if (!session) throw invalidSession();

    const audit = {
      tenantId: session.user.tenantId,
      siteId: session.siteId,
      actorId: session.userId,
      deviceId: session.deviceId,
      ip: client.ip,
    };

    if (session.rotatedAt || session.revokedAt) {
      if (session.rotatedAt) {
        await this.revokeFamily(session.familyId);
        await this.audit.log({
          ...audit,
          action: 'auth.refresh_reuse_detected',
          entity: 'auth_session',
          entityId: session.id,
        });
      }
      throw invalidSession();
    }
    if (session.expiresAt <= new Date() || !session.user.active) throw invalidSession();
    // Une session ouverte par PIN reste liée à l'appareil qui l'a ouverte.
    if (session.deviceId && session.deviceId !== device?.id) throw invalidSession();

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.authSession.updateMany({
        where: { id: session.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: new Date() },
      });
      if (claimed.count !== 1) throw invalidSession();
      return this.tokens.issue(
        {
          userId: session.userId,
          tenantId: session.user.tenantId,
          siteId: session.siteId,
          deviceId: session.deviceId,
          method: session.method,
          familyId: session.familyId,
          ...client,
        },
        tx,
      );
    });
  }

  /** Déconnexion : révoque la session liée au jeton de rafraîchissement (et toute sa famille). */
  async logout(
    refreshToken: string | undefined,
    auth: AuthContext | undefined,
    client: ClientInfo,
  ): Promise<void> {
    const session = refreshToken
      ? await this.prisma.authSession.findUnique({ where: { refreshTokenHash: sha256(refreshToken) } })
      : auth
        ? await this.prisma.authSession.findUnique({ where: { id: auth.sessionId } })
        : null;
    if (!session) return;
    await this.revokeFamily(session.familyId);
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (user) {
      await this.audit.log({
        tenantId: user.tenantId,
        siteId: session.siteId,
        actorId: user.id,
        deviceId: session.deviceId,
        action: 'auth.logout',
        ip: client.ip,
      });
    }
  }

  /** Profil de l'utilisateur connecté, avec ses droits sur le site courant. */
  async me(auth: AuthContext) {
    const [user, site, role] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } }),
      this.prisma.site.findUniqueOrThrow({ where: { id: auth.siteId }, include: { tenant: true } }),
      this.access.resolveRole(auth.userId, auth.siteId),
    ]);
    if (!role) throw new ForbiddenException({ code: 'NO_ACCESS_TO_SITE', message: 'Aucun rôle sur ce site' });

    return {
      user: { id: user.id, displayName: user.displayName, username: user.username, locale: user.locale },
      tenant: { id: site.tenant.id, name: site.tenant.name },
      site: { id: site.id, name: site.name },
      role: { code: role.roleCode, name: role.roleName },
      grants: role.grants,
      session: { method: auth.method, deviceId: auth.deviceId },
      autoLockSeconds: autoLockSeconds(site.settings, role.roleCode, auth.method),
    };
  }

  // ------------------------------------------------------------------ outils internes

  private async resolveTenant(input: PasswordLoginInput): Promise<{ tenantId: string; siteId?: string }> {
    if (this.config.API_MODE === 'site') {
      const site = await this.prisma.site.findUniqueOrThrow({ where: { id: this.config.SITE_ID! } });
      return { tenantId: site.tenantId, siteId: site.id };
    }
    if (!input.tenant)
      throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'Établissement requis' });
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: input.tenant } });
    // Réponse identique à un mauvais mot de passe : on ne révèle pas quels clients existent.
    if (!tenant || tenant.status !== 'active') {
      await verifySecret(null, input.password);
      throw invalidCredentials();
    }
    return { tenantId: tenant.id, siteId: input.siteId };
  }

  private async defaultSiteFor(userId: string, tenantId: string): Promise<string> {
    const link = await this.prisma.userSiteRole.findFirst({
      where: { userId },
      orderBy: { siteId: { sort: 'asc', nulls: 'last' } },
    });
    const siteId =
      link?.siteId ??
      (
        await this.prisma.site.findFirst({
          where: { tenantId, archivedAt: null },
          orderBy: { createdAt: 'asc' },
        })
      )?.id;
    if (!siteId)
      throw new ForbiddenException({ code: 'NO_ACCESS_TO_SITE', message: 'Aucun site accessible' });
    return siteId;
  }

  private async assertSiteAccess(userId: string, tenantId: string, siteId: string): Promise<void> {
    const site = await this.prisma.site.findFirst({ where: { id: siteId, tenantId, archivedAt: null } });
    const role = site ? await this.access.resolveRole(userId, siteId) : null;
    if (!role) {
      throw new ForbiddenException({ code: 'NO_ACCESS_TO_SITE', message: "Vous n'avez pas accès à ce site" });
    }
  }

  private async registerPinFailure(
    userId: string,
    previousFailures: number,
    base: { tenantId: string; siteId: string; deviceId: string; ip?: string },
  ): Promise<void> {
    const failures = previousFailures + 1;
    const locked = failures >= PIN_MAX_ATTEMPTS;
    await this.prisma.user.update({
      where: { id: userId },
      data: locked
        ? { pinFailedCount: 0, pinLockedUntil: new Date(Date.now() + PIN_LOCK_MINUTES * 60_000) }
        : { pinFailedCount: failures },
    });
    await this.audit.log({
      ...base,
      actorId: userId,
      action: locked ? 'auth.pin_locked' : 'auth.login_failed',
      after: { method: 'pin', failures },
    });
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

/** Délai de verrouillage automatique selon le poste (paramètres du site, docs/architecture/05). */
export function autoLockSeconds(settings: unknown, roleCode: string, method: 'password' | 'pin'): number {
  const defaults = { cashier: 60, waiter: 180, backOffice: 600 };
  const s = {
    ...defaults,
    ...((settings as { autoLockSeconds?: Partial<typeof defaults> })?.autoLockSeconds ?? {}),
  };
  if (method === 'password') return s.backOffice;
  if (roleCode === 'cashier') return s.cashier;
  if (roleCode === 'waiter' || roleCode === 'kitchen') return s.waiter;
  return s.backOffice;
}
