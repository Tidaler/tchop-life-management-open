import { Injectable } from '@nestjs/common';
import { type GrantLevel, type Grants, isPermission } from '@tchop/shared';
import { PrismaService } from '../prisma.service.js';

export interface ResolvedRole {
  roleId: string;
  roleCode: string;
  roleName: { fr: string; en: string };
  grants: Grants;
}

/** Rôle et droits d'un utilisateur sur un site. */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Un rôle propre au site l'emporte sur un rôle « tous les sites » (site_id nul, propriétaire).
   * L'appelant doit avoir vérifié que le site appartient au client de l'utilisateur.
   */
  async resolveRole(userId: string, siteId: string): Promise<ResolvedRole | null> {
    const link = await this.prisma.userSiteRole.findFirst({
      where: { userId, OR: [{ siteId }, { siteId: null }] },
      orderBy: { siteId: { sort: 'asc', nulls: 'last' } },
      include: { role: { include: { permissions: true } } },
    });
    if (!link) return null;

    const grants: Grants = {};
    for (const p of link.role.permissions) {
      if (isPermission(p.permission)) grants[p.permission] = p.level as GrantLevel;
    }
    return {
      roleId: link.role.id,
      roleCode: link.role.code,
      roleName: link.role.name as ResolvedRole['roleName'],
      grants,
    };
  }
}
