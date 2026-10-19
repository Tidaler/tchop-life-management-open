import { Injectable } from '@nestjs/common';
import { type Prisma } from '@tchop/db';
import { type AuditQuery } from '@tchop/shared';
import { type AuthContext } from '../common/request-context.js';
import { zonedMidnight } from '../common/site-settings.js';
import { PrismaService } from '../prisma.service.js';

const nextDay = (day: string): string =>
  new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

/** Consultation du journal d'audit du site (lecture seule : le journal est en ajout seul). */
@Injectable()
export class AuditViewService {
  constructor(private readonly prisma: PrismaService) {}

  async list(auth: AuthContext, q: AuditQuery) {
    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: auth.siteId } });
    const createdAt: Prisma.DateTimeFilter = {};
    if (q.from) createdAt.gte = zonedMidnight(q.from, site.timezone);
    if (q.to) createdAt.lt = zonedMidnight(nextDay(q.to), site.timezone);
    const rows = await this.prisma.auditLog.findMany({
      where: {
        tenantId: auth.tenantId,
        siteId: auth.siteId,
        ...(q.from || q.to ? { createdAt } : {}),
        ...(q.action ? { action: { startsWith: q.action } } : {}),
        actorId: q.actorId,
        // Identifiants UUID v7 : leur ordre est celui de l'écriture.
        ...(q.before ? { id: { lt: q.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit,
    });
    const ids = [...new Set(rows.flatMap((r) => [r.actorId, r.approverId]).filter((v): v is string => !!v))];
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, displayName: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, u.displayName]));
    return {
      entries: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        actor: r.actorId ? (names.get(r.actorId) ?? null) : null,
        approver: r.approverId ? (names.get(r.approverId) ?? null) : null,
        reason: r.reason,
        before: r.before,
        after: r.after,
      })),
      next: rows.length === q.limit ? rows.at(-1)!.id : null,
    };
  }
}
