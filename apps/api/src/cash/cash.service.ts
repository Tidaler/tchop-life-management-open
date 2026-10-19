import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { type PaymentMethod, type Prisma } from '@tchop/db';
import { can, type CloseSessionInput, type OpenSessionInput, PAYMENT_METHODS } from '@tchop/shared';
import { AuditService } from '../audit/audit.service.js';
import { isUniqueViolation, notFound } from '../common/errors.js';
import { type AuthContext } from '../common/request-context.js';
import { type ZReportDoc } from '../printing/escpos.js';
import { PrintService } from '../printing/print.service.js';
import { PrismaService } from '../prisma.service.js';

type Tx = Prisma.TransactionClient;

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Espèces',
  mtn_momo: 'MTN MoMo',
  orange_money: 'Orange Money',
  card: 'Carte',
  customer_credit: 'Ardoise',
};

const noOpenSession = () =>
  new ConflictException({ code: 'NO_OPEN_SESSION', message: "Ouvrez d'abord votre session de caisse" });

/** Sessions de caisse : ouverture avec fond initial, totaux en cours, clôture avec écart justifié. */
@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly print: PrintService,
  ) {}

  async registers(auth: AuthContext): Promise<{ id: string; name: string }[]> {
    return this.prisma.cashRegister.findMany({
      where: { siteId: auth.siteId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });
  }

  /** Session ouverte de l'utilisateur (une seule à la fois), ou null. */
  async current(auth: AuthContext) {
    const session = await this.prisma.cashSession.findFirst({
      where: { siteId: auth.siteId, cashierId: auth.userId, status: 'open' },
      include: { register: true },
    });
    return session ? this.summary(session.id) : null;
  }

  /** Session ouverte du caissier : obligatoire pour tout encaissement. */
  async requireOpenSession(tx: Tx, auth: AuthContext) {
    const session = await tx.cashSession.findFirst({
      where: { siteId: auth.siteId, cashierId: auth.userId, status: 'open' },
    });
    if (!session) throw noOpenSession();
    return session;
  }

  async open(auth: AuthContext, input: OpenSessionInput) {
    try {
      const session = await this.prisma.$transaction(async (tx) => {
        const register = await tx.cashRegister.findFirst({
          where: { id: input.registerId, siteId: auth.siteId, archivedAt: null },
        });
        if (!register) throw notFound('Caisse');
        const created = await tx.cashSession.create({
          data: {
            siteId: auth.siteId,
            registerId: register.id,
            cashierId: auth.userId,
            openingFloatXaf: input.openingFloatXaf,
          },
        });
        await this.log(tx, auth, 'cash.session_opened', created.id, {
          register: register.name,
          openingFloatXaf: input.openingFloatXaf,
        });
        return created;
      });
      return this.summary(session.id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'SESSION_ALREADY_OPEN',
          message: 'Une session est déjà ouverte sur cette caisse ou pour vous',
        });
      }
      throw error;
    }
  }

  /** Totaux théoriques d'une session : paiements non annulés et règlements d'ardoise, par moyen. */
  async summary(sessionId: string, tx: Tx = this.prisma) {
    const session = await tx.cashSession.findUniqueOrThrow({
      where: { id: sessionId },
      include: { register: true },
    });
    // Requêtes l'une après l'autre : dans une transaction, elles partagent une seule connexion.
    const payments = await tx.payment.groupBy({
      by: ['method'],
      where: { sessionId, status: { not: 'voided' } },
      _sum: { amountXaf: true },
      _count: true,
    });
    const settlements = await tx.customerLedgerEntry.groupBy({
      by: ['method'],
      where: { sessionId, type: 'payment' },
      _sum: { amountXaf: true },
    });
    const cashier = await tx.user.findUnique({
      where: { id: session.cashierId },
      select: { displayName: true },
    });
    // Dépenses payées avec les espèces de cette caisse : elles sortent du théorique.
    const expenses = await tx.expense.aggregate({
      where: { sessionId, status: 'recorded' },
      _sum: { amountXaf: true },
      _count: true,
    });
    const cashExpensesXaf = expenses._sum.amountXaf ?? 0;
    const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<PaymentMethod, number>;
    let count = 0;
    for (const p of payments) {
      byMethod[p.method] += p._sum.amountXaf ?? 0;
      count += p._count;
    }
    // Un règlement d'ardoise est une écriture négative : l'argent entre dans la caisse.
    for (const s of settlements) if (s.method) byMethod[s.method] -= s._sum.amountXaf ?? 0;

    return {
      id: session.id,
      status: session.status,
      register: { id: session.register.id, name: session.register.name },
      cashierId: session.cashierId,
      cashierName: cashier?.displayName ?? '',
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      openingFloatXaf: session.openingFloatXaf,
      byMethod,
      paymentCount: count,
      cashExpensesXaf,
      cashExpenseCount: expenses._count,
      expectedCashXaf: session.openingFloatXaf + byMethod.cash - cashExpensesXaf,
      countedCashXaf: session.countedCashXaf,
      differenceXaf: session.differenceXaf,
      comment: session.comment,
    };
  }

  /**
   * Clôture : écart = espèces comptées − espèces attendues. Commentaire obligatoire si écart.
   * Clôturer la session d'un autre caissier demande les droits d'approbation (gérant).
   */
  async close(auth: AuthContext, sessionId: string, input: CloseSessionInput) {
    const result = await this.prisma.$transaction(async (tx) => {
      const session = await tx.cashSession.findFirst({ where: { id: sessionId, siteId: auth.siteId } });
      if (!session) throw notFound('Session de caisse');
      if (session.status !== 'open') {
        throw new ConflictException({ code: 'SESSION_CLOSED', message: 'Session déjà clôturée' });
      }
      if (session.cashierId !== auth.userId && !can(auth.grants, 'approval.grant')) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'Seul le caissier ou un gérant peut clôturer',
        });
      }
      // Verrou : plus aucun paiement ne peut entrer dans la session pendant la clôture.
      await tx.$queryRaw`SELECT 1 FROM "cash_session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
      const totals = await this.summary(sessionId, tx);
      const difference = input.countedCashXaf - totals.expectedCashXaf;
      if (difference !== 0 && !input.comment) {
        throw new BadRequestException({
          code: 'COMMENT_REQUIRED',
          message: 'Un écart de caisse doit être expliqué par un commentaire',
          differenceXaf: difference,
        });
      }
      await tx.cashSession.update({
        where: { id: sessionId },
        data: {
          status: 'closed',
          closedAt: new Date(),
          closedById: auth.userId,
          expected: totals.byMethod as unknown as Prisma.InputJsonValue,
          countedCashXaf: input.countedCashXaf,
          differenceXaf: difference,
          comment: input.comment ?? null,
        },
      });
      await this.log(
        tx,
        auth,
        'cash.session_closed',
        sessionId,
        {
          expectedCashXaf: totals.expectedCashXaf,
          cashExpensesXaf: totals.cashExpensesXaf,
          countedCashXaf: input.countedCashXaf,
          differenceXaf: difference,
          byMethod: totals.byMethod,
        },
        input.comment,
      );

      const site = await tx.site.findUniqueOrThrow({ where: { id: auth.siteId } });
      const closed = await this.summary(sessionId, tx);
      const doc: ZReportDoc = {
        kind: 'z_report',
        siteName: site.name,
        registerName: closed.register.name,
        cashierName: closed.cashierName,
        openedAt: closed.openedAt.toISOString(),
        closedAt: (closed.closedAt ?? new Date()).toISOString(),
        timeZone: site.timezone,
        openingFloatXaf: closed.openingFloatXaf,
        expected: PAYMENT_METHODS.map((m) => ({ label: METHOD_LABELS[m], amountXaf: closed.byMethod[m] })),
        cashExpensesXaf: closed.cashExpensesXaf,
        expectedCashXaf: closed.expectedCashXaf,
        countedCashXaf: input.countedCashXaf,
        differenceXaf: difference,
        comment: input.comment ?? null,
        paymentCount: closed.paymentCount,
      };
      await this.print.enqueue(tx, auth.siteId, 'cashier', doc);
      return closed;
    });
    void this.print.processDue();
    return result;
  }

  private log(tx: Tx, auth: AuthContext, action: string, id: string, after?: object, reason?: string) {
    return this.audit.log(
      {
        tenantId: auth.tenantId,
        siteId: auth.siteId,
        actorId: auth.userId,
        deviceId: auth.deviceId,
        action,
        entity: 'cash_session',
        entityId: id,
        after: after as Prisma.InputJsonValue | undefined,
        reason,
      },
      tx,
    );
  }
}
