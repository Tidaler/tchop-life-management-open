import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { type Prisma } from '@tchop/db';
import { can, type ApprovalInput, type Permission, needsApproval } from '@tchop/shared';
import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../auth/access.service.js';
import { PIN_LOCK_MINUTES, PIN_MAX_ATTEMPTS } from '../auth/auth.service.js';
import { verifySecret } from '../auth/password.js';
import { type AuthContext } from '../common/request-context.js';
import { PrismaService } from '../prisma.service.js';

const approvalRequired = () =>
  new ForbiddenException({
    code: 'APPROVAL_REQUIRED',
    message: "Cette action demande l'approbation d'un gérant",
  });

/**
 * Approbation d'une action sensible par le PIN d'un gérant présent (docs/architecture/04, « Approbation »).
 * L'approbateur doit être une autre personne que l'auteur de l'action.
 */
@Injectable()
export class ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Renvoie l'identifiant de l'approbateur, ou null si l'utilisateur peut agir seul.
   * Lève APPROVAL_REQUIRED si une approbation manque, APPROVAL_INVALID si elle est refusée.
   */
  async require(
    auth: AuthContext,
    permission: Permission,
    approval: ApprovalInput | undefined,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<string | null> {
    if (needsApproval(auth.grants, permission) !== 'always') return null;
    if (!approval) throw approvalRequired();
    return this.verify(auth, approval, tx);
  }

  /** Approbation obligatoire quel que soit le rôle (ex. ardoise au-delà du plafond, remise au-delà du seuil). */
  async requireApprover(
    auth: AuthContext,
    approval: ApprovalInput | undefined,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<string> {
    if (!approval) throw approvalRequired();
    return this.verify(auth, approval, tx);
  }

  /** Personnes du site qui peuvent approuver (droit approval.grant et PIN défini), hors l'utilisateur courant. */
  async listApprovers(auth: AuthContext) {
    const links = await this.prisma.userSiteRole.findMany({
      where: {
        OR: [{ siteId: auth.siteId }, { siteId: null }],
        userId: { not: auth.userId },
        user: { tenantId: auth.tenantId, active: true, pinHash: { not: null } },
        role: { permissions: { some: { permission: 'approval.grant' } } },
      },
      include: { user: { select: { id: true, displayName: true } } },
      orderBy: { user: { displayName: 'asc' } },
    });
    const seen = new Set<string>();
    return links
      .filter((l) => !seen.has(l.userId) && seen.add(l.userId))
      .map((l) => ({ id: l.user.id, displayName: l.user.displayName }));
  }

  private async verify(
    auth: AuthContext,
    approval: ApprovalInput,
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const refuse = () =>
      new ForbiddenException({
        code: 'APPROVAL_INVALID',
        message: 'Approbation refusée : PIN ou droits du gérant',
      });
    if (approval.userId === auth.userId) throw refuse();

    const approver = await tx.user.findFirst({
      where: { id: approval.userId, tenantId: auth.tenantId, active: true },
    });
    if (approver?.pinLockedUntil && approver.pinLockedUntil > new Date()) {
      throw new HttpException(
        { code: 'PIN_LOCKED', message: 'Trop de tentatives, réessayez plus tard' },
        HttpStatus.LOCKED,
      );
    }
    const pinOk = await verifySecret(approver?.pinHash, approval.pin);
    if (!approver || !pinOk) {
      if (approver) await this.registerFailure(approver.id, approver.pinFailedCount, auth);
      throw refuse();
    }
    const role = await this.access.resolveRole(approver.id, auth.siteId);
    if (!role || !can(role.grants, 'approval.grant')) throw refuse();
    if (approver.pinFailedCount > 0) {
      await tx.user.update({ where: { id: approver.id }, data: { pinFailedCount: 0 } });
    }
    return approver.id;
  }

  /** Un PIN d'approbation faux compte comme une tentative de connexion ratée (même blocage). */
  private async registerFailure(userId: string, previous: number, auth: AuthContext): Promise<void> {
    const failures = previous + 1;
    const locked = failures >= PIN_MAX_ATTEMPTS;
    await this.prisma.user.update({
      where: { id: userId },
      data: locked
        ? { pinFailedCount: 0, pinLockedUntil: new Date(Date.now() + PIN_LOCK_MINUTES * 60_000) }
        : { pinFailedCount: failures },
    });
    await this.audit.log({
      tenantId: auth.tenantId,
      siteId: auth.siteId,
      actorId: auth.userId,
      deviceId: auth.deviceId,
      action: locked ? 'auth.pin_locked' : 'approval.failed',
      entity: 'user',
      entityId: userId,
    });
  }
}
