import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@tchop/db';
import { type EnrollDeviceInput } from '@tchop/shared';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { AuditService } from '../audit/audit.service.js';
import { newNumericCode, newOpaqueToken, sha256 } from '../common/crypto.js';
import { type AuthContext, type DeviceContext } from '../common/request-context.js';
import { PrismaService } from '../prisma.service.js';

export const ENROLLMENT_CODE_TTL_MINUTES = 10;

/** Le code n'est unique que pour un site : son empreinte inclut l'identifiant du site. */
const codeHash = (siteId: string, code: string) => sha256(`${siteId}:${code}`);

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Code à 6 chiffres que le gérant affiche puis saisit sur la nouvelle tablette. */
  async createEnrollmentCode(auth: AuthContext) {
    const expiresAt = new Date(Date.now() + ENROLLMENT_CODE_TTL_MINUTES * 60_000);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newNumericCode();
      try {
        await this.prisma.deviceEnrollmentCode.create({
          data: {
            siteId: auth.siteId,
            codeHash: codeHash(auth.siteId, code),
            expiresAt,
            createdById: auth.userId,
          },
        });
        await this.audit.log({
          tenantId: auth.tenantId,
          siteId: auth.siteId,
          actorId: auth.userId,
          action: 'device.enrollment_code_created',
        });
        return { code, expiresAt };
      } catch (error) {
        // Collision avec un code existant du même site : on en tire un autre.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      }
    }
    throw new Error("Impossible de générer un code d'enregistrement unique");
  }

  /** Enregistre un appareil avec un code valide. Le jeton d'appareil n'est renvoyé qu'une seule fois. */
  async enroll(input: EnrollDeviceInput, ip?: string) {
    if (this.config.API_MODE !== 'site') {
      throw new BadRequestException({
        code: 'SITE_MODE_ONLY',
        message: 'Les appareils s’enregistrent sur le serveur local du site',
      });
    }
    const siteId = this.config.SITE_ID!;
    const deviceToken = newOpaqueToken();

    const device = await this.prisma.$transaction(async (tx) => {
      const enrollment = await tx.deviceEnrollmentCode.findUnique({
        where: { codeHash: codeHash(siteId, input.code) },
      });
      const claimed = enrollment
        ? await tx.deviceEnrollmentCode.updateMany({
            where: { id: enrollment.id, usedAt: null, expiresAt: { gt: new Date() } },
            data: { usedAt: new Date() },
          })
        : { count: 0 };
      if (!enrollment || claimed.count !== 1) {
        throw new UnauthorizedException({
          code: 'INVALID_ENROLLMENT_CODE',
          message: 'Code invalide ou expiré',
        });
      }

      const created = await tx.device.create({
        data: {
          siteId,
          name: input.name,
          kind: input.kind,
          tokenHash: sha256(deviceToken),
          createdById: enrollment.createdById,
          lastSeenAt: new Date(),
        },
        include: { site: true },
      });
      await tx.deviceEnrollmentCode.update({ where: { id: enrollment.id }, data: { deviceId: created.id } });
      await this.audit.log(
        {
          tenantId: created.site.tenantId,
          siteId,
          actorId: enrollment.createdById,
          deviceId: created.id,
          action: 'device.enrolled',
          entity: 'device',
          entityId: created.id,
          after: { name: created.name, kind: created.kind },
          ip,
        },
        tx,
      );
      return created;
    });

    return {
      deviceToken,
      device: { id: device.id, name: device.name, kind: device.kind, siteId, siteName: device.site.name },
    };
  }

  /** Informations affichées sur l'écran de connexion par PIN de l'appareil. */
  async describeDevice(device: DeviceContext) {
    const site = await this.prisma.site.findUniqueOrThrow({
      where: { id: device.siteId },
      include: { tenant: true },
    });
    const links = await this.prisma.userSiteRole.findMany({
      where: {
        OR: [{ siteId: site.id }, { siteId: null }],
        user: { tenantId: site.tenantId, active: true, pinHash: { not: null } },
      },
      include: { user: true, role: true },
      orderBy: { user: { displayName: 'asc' } },
    });

    // Un utilisateur peut avoir un rôle du site et un rôle « tous les sites » : le rôle du site l'emporte.
    const users = new Map<
      string,
      { id: string; displayName: string; role: { code: string; name: unknown } }
    >();
    for (const l of links) {
      if (users.has(l.userId) && l.siteId === null) continue;
      users.set(l.userId, {
        id: l.user.id,
        displayName: l.user.displayName,
        role: { code: l.role.code, name: l.role.name },
      });
    }

    return {
      device: { id: device.id, name: device.name },
      site: { id: site.id, name: site.name, tenantName: site.tenant.name },
      users: [...users.values()],
    };
  }

  async list(auth: AuthContext) {
    const devices = await this.prisma.device.findMany({
      where: { siteId: auth.siteId },
      orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'asc' }],
    });
    return devices.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      lastSeenAt: d.lastSeenAt,
      revokedAt: d.revokedAt,
      createdAt: d.createdAt,
    }));
  }

  /** Révoque un appareil (perdu, volé, remplacé) et ferme toutes ses sessions. */
  async revoke(id: string, auth: AuthContext, ip?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const device = await tx.device.findFirst({ where: { id, siteId: auth.siteId } });
      if (!device) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Appareil introuvable' });
      if (device.revokedAt) return;
      const now = new Date();
      await tx.device.update({ where: { id }, data: { revokedAt: now } });
      await tx.authSession.updateMany({ where: { deviceId: id, revokedAt: null }, data: { revokedAt: now } });
      await this.audit.log(
        {
          tenantId: auth.tenantId,
          siteId: auth.siteId,
          actorId: auth.userId,
          action: 'device.revoked',
          entity: 'device',
          entityId: id,
          before: { name: device.name },
          ip,
        },
        tx,
      );
    });
  }
}
