import { ConflictException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { type Prisma, type RefundMethod } from '@tchop/db';
import { pickText, type RefundInput, type Translated } from '@tchop/shared';
import { ApprovalService } from '../approval/approval.service.js';
import { AuditService } from '../audit/audit.service.js';
import { nextCounter } from '../common/counters.js';
import { isUniqueViolation, notFound } from '../common/errors.js';
import { type AuthContext } from '../common/request-context.js';
import { EventsService } from '../events/events.gateway.js';
import { type RefundDoc } from '../printing/escpos.js';
import { PrintService } from '../printing/print.service.js';
import { PrismaService } from '../prisma.service.js';
import { StockLedger } from '../stock/stock-ledger.js';
import { CashService } from './cash.service.js';

type Tx = Prisma.TransactionClient;

export const REFUND_LABELS: Record<RefundMethod, string> = {
  cash: 'Espèces',
  mtn_momo: 'MTN MoMo',
  orange_money: 'Orange Money',
  card: 'Carte',
  customer_credit: 'Avoir sur ardoise',
};

const billInclude = {
  order: { include: { table: true } },
  lines: { include: { orderLine: true } },
  payments: true,
  receipt: true,
} satisfies Prisma.BillInclude;

/**
 * Remboursements et avoirs sur additions payées (cahier des charges 4.5) : approbation selon le rôle,
 * jamais plus que ce qui a été payé, avoir numéroté imprimé et figé, journal d'audit.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approval: ApprovalService,
    private readonly cash: CashService,
    private readonly events: EventsService,
    private readonly print: PrintService,
    private readonly ledger: StockLedger,
  ) {}

  /** Addition payée retrouvée par son n° de reçu, avec ce qui reste remboursable ligne par ligne. */
  async byReceipt(auth: AuthContext, receiptNumber: number) {
    const receipt = await this.prisma.receipt.findUnique({
      where: { siteId_number: { siteId: auth.siteId, number: receiptNumber } },
    });
    if (!receipt) throw notFound('Reçu');
    return this.detail(this.prisma, auth, receipt.billId);
  }

  private async detail(db: Tx, auth: AuthContext, billId: string) {
    const bill = await db.bill.findFirst({
      where: { id: billId, siteId: auth.siteId },
      include: billInclude,
    });
    if (!bill) throw notFound('Addition');
    const refunds = await db.refund.findMany({
      where: { billId },
      include: { lines: true },
      orderBy: { number: 'asc' },
    });
    const refundedQty = new Map<string, number>();
    for (const r of refunds)
      for (const l of r.lines)
        refundedQty.set(l.orderLineId, (refundedQty.get(l.orderLineId) ?? 0) + l.quantity);
    const refundedXaf = refunds.reduce((s, r) => s + r.amountXaf, 0);
    const customers = [
      ...new Set(
        bill.payments.filter((p) => p.customerId && p.status !== 'voided').map((p) => p.customerId!),
      ),
    ];
    return {
      billId: bill.id,
      status: bill.status,
      receiptNumber: bill.receipt?.number ?? null,
      orderNumber: bill.order.number,
      tableLabel: bill.order.table?.label ?? null,
      paidAt: bill.paidAt,
      subtotalXaf: bill.subtotalXaf,
      discountXaf: bill.discountXaf,
      totalXaf: bill.totalXaf,
      refundedXaf,
      refundableXaf: bill.status === 'paid' ? bill.totalXaf - refundedXaf : 0,
      /** Client d'une ardoise ayant servi à payer : destinataire naturel d'un avoir. */
      customerIds: customers,
      lines: bill.lines.map((l) => ({
        orderLineId: l.orderLineId,
        name: l.orderLine.name as Translated,
        quantity: l.quantity,
        amountXaf: l.amountXaf,
        refundedQuantity: refundedQty.get(l.orderLineId) ?? 0,
      })),
      refunds: refunds.map((r) => ({
        id: r.id,
        number: r.number,
        method: r.method,
        amountXaf: r.amountXaf,
        reason: r.reason,
        restocked: r.restocked,
        createdAt: r.createdAt,
      })),
    };
  }

  /** Remboursements de la période (pour l'écran de caisse) : n°, addition, montant, moyen. */
  async list(auth: AuthContext, sinceHours = 24) {
    const rows = await this.prisma.refund.findMany({
      where: { siteId: auth.siteId, createdAt: { gte: new Date(Date.now() - sinceHours * 3_600_000) } },
      orderBy: { number: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      method: r.method,
      amountXaf: r.amountXaf,
      reason: r.reason,
      createdAt: r.createdAt,
      content: r.snapshot as unknown as RefundDoc,
    }));
  }

  async refund(auth: AuthContext, billId: string, input: RefundInput) {
    const replay = await this.findReplay(auth, input.idempotencyKey);
    if (replay) return replay;
    try {
      const refundId = await this.prisma.$transaction(async (tx) => {
        // Espèces : elles sortent de la caisse ouverte de l'utilisateur, verrouillée contre une clôture
        // simultanée. Autres moyens : la session est rattachée si elle existe (traçabilité), sans obligation.
        const session =
          input.method === 'cash'
            ? await this.cash.requireOpenSession(tx, auth)
            : await tx.cashSession.findFirst({
                where: { siteId: auth.siteId, cashierId: auth.userId, status: 'open' },
              });
        if (session) {
          const [locked] = await tx.$queryRaw<{ status: string }[]>`
            SELECT "status" FROM "cash_session" WHERE "id" = ${session.id}::uuid FOR SHARE`;
          if (locked?.status !== 'open' && input.method === 'cash') {
            throw new ConflictException({
              code: 'NO_OPEN_SESSION',
              message: "Ouvrez d'abord votre session de caisse",
            });
          }
        }
        const sessionId = session?.id ?? null;
        await tx.$queryRaw`SELECT 1 FROM "bill" WHERE "id" = ${billId}::uuid FOR UPDATE`;
        const bill = await tx.bill.findFirst({
          where: { id: billId, siteId: auth.siteId },
          include: billInclude,
        });
        if (!bill) throw notFound('Addition');
        if (bill.status !== 'paid') {
          throw new ConflictException({
            code: 'BILL_NOT_PAID',
            message: 'Seule une addition payée peut être remboursée',
          });
        }
        const approvedById = await this.approval.require(auth, 'refund.create', input.approval, tx);
        const state = await this.detail(tx, auth, billId);

        // Lignes remboursées : jamais plus que la quantité facturée moins ce qui a déjà été remboursé.
        // Montant au prorata de la remise de l'addition (on ne rend jamais plus que ce qui a été payé).
        const ratio = bill.subtotalXaf > 0 ? bill.totalXaf / bill.subtotalXaf : 0;
        const lines = (input.lines ?? []).map((wanted) => {
          const line = state.lines.find((l) => l.orderLineId === wanted.orderLineId);
          if (!line) throw notFound('Ligne de l’addition');
          if (wanted.quantity > line.quantity - line.refundedQuantity) {
            throw new HttpException(
              {
                code: 'REFUND_TOO_LARGE',
                message: `${pickText(line.name, 'fr')} : quantité déjà remboursée ou supérieure à la vente`,
              },
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }
          return {
            ...line,
            refundQty: wanted.quantity,
            refundXaf: Math.round(((line.amountXaf * wanted.quantity) / line.quantity) * ratio),
          };
        });
        const amount = input.amountXaf ?? lines.reduce((s, l) => s + l.refundXaf, 0);
        if (amount <= 0 || amount > state.refundableXaf) {
          throw new HttpException(
            {
              code: 'REFUND_TOO_LARGE',
              message: 'Montant supérieur à ce qui reste remboursable',
              refundableXaf: state.refundableXaf,
            },
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        let customerName: string | null = null;
        if (input.method === 'customer_credit') {
          const customer = await tx.customer.findFirst({
            where: { id: input.customerId, siteId: auth.siteId, active: true },
          });
          if (!customer) throw notFound('Client');
          customerName = customer.name;
        }

        const site = await tx.site.findUniqueOrThrow({ where: { id: auth.siteId } });
        const cashier = await tx.user.findUniqueOrThrow({ where: { id: auth.userId } });
        const number = await nextCounter(tx, auth.siteId, 'refund');
        const doc: RefundDoc = {
          kind: 'refund',
          siteName: site.name,
          refundNumber: number,
          receiptNumber: bill.receipt?.number ?? null,
          orderNumber: bill.order.number,
          tableLabel: bill.order.table?.label ?? null,
          cashierName: cashier.displayName,
          createdAt: new Date().toISOString(),
          timeZone: site.timezone,
          lines: lines.map((l) => ({
            quantity: l.refundQty,
            name: pickText(l.name, 'fr'),
            amountXaf: l.refundXaf,
          })),
          amountXaf: amount,
          methodLabel: REFUND_LABELS[input.method],
          creditNote: input.method === 'customer_credit',
          reference: input.reference ?? null,
          customerName,
          reason: input.reason,
          restocked: input.restock,
        };
        const refund = await tx.refund.create({
          data: {
            siteId: auth.siteId,
            number,
            billId,
            sessionId,
            method: input.method,
            amountXaf: amount,
            reason: input.reason,
            reference: input.reference ?? null,
            customerId: input.customerId ?? null,
            restocked: input.restock,
            snapshot: doc as unknown as Prisma.InputJsonValue,
            idempotencyKey: input.idempotencyKey,
            createdById: auth.userId,
            approvedById,
            lines: {
              create: lines.map((l) => ({
                orderLineId: l.orderLineId,
                quantity: l.refundQty,
                amountXaf: l.refundXaf,
              })),
            },
          },
        });

        // Avoir : le client doit moins (écriture négative sur son ardoise, en ajout seul).
        if (input.method === 'customer_credit') {
          await tx.customerLedgerEntry.create({
            data: {
              customerId: input.customerId!,
              type: 'adjustment',
              amountXaf: -amount,
              billId,
              sessionId,
              createdById: auth.userId,
              approvedById,
              note: `Avoir n° ${number}`,
            },
          });
        }
        if (input.restock) {
          for (const l of lines) {
            const sold = bill.lines.find((b) => b.orderLineId === l.orderLineId)!.orderLine.quantity;
            await this.ledger.restockSold(
              tx,
              auth.siteId,
              auth.userId,
              l.orderLineId,
              l.refundQty / sold,
              `Remboursement n° ${number}`,
              approvedById,
            );
          }
        }
        await this.print.enqueue(tx, auth.siteId, 'cashier', doc);
        await this.audit.log(
          {
            tenantId: auth.tenantId,
            siteId: auth.siteId,
            actorId: auth.userId,
            approverId: approvedById,
            deviceId: auth.deviceId,
            action: 'refund.created',
            entity: 'bill',
            entityId: billId,
            after: {
              refundNumber: number,
              receiptNumber: bill.receipt?.number ?? null,
              method: input.method,
              amountXaf: amount,
              restocked: input.restock,
              lines: lines.map((l) => ({ product: pickText(l.name, 'fr'), quantity: l.refundQty })),
            },
            reason: input.reason,
          },
          tx,
        );
        return refund.id;
      });
      void this.print.processDue();
      const created = await this.get(auth, refundId);
      this.events.emit(auth.siteId, { type: 'bills.changed', orderId: created.orderId });
      if (input.restock) this.events.emit(auth.siteId, { type: 'stock.changed' });
      return created;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrent = await this.findReplay(auth, input.idempotencyKey);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  async reprint(auth: AuthContext, refundId: string) {
    const refund = await this.prisma.refund.findFirst({ where: { id: refundId, siteId: auth.siteId } });
    if (!refund) throw notFound('Remboursement');
    await this.prisma.$transaction(async (tx) => {
      await this.print.enqueue(tx, auth.siteId, 'cashier', refund.snapshot as unknown as RefundDoc);
      await this.audit.log(
        {
          tenantId: auth.tenantId,
          siteId: auth.siteId,
          actorId: auth.userId,
          deviceId: auth.deviceId,
          action: 'refund.reprinted',
          entity: 'bill',
          entityId: refund.billId,
          after: { refundNumber: refund.number },
        },
        tx,
      );
    });
    void this.print.processDue();
  }

  private async get(auth: AuthContext, refundId: string) {
    const refund = await this.prisma.refund.findFirstOrThrow({
      where: { id: refundId, siteId: auth.siteId },
    });
    const bill = await this.prisma.bill.findUniqueOrThrow({ where: { id: refund.billId } });
    return {
      id: refund.id,
      number: refund.number,
      billId: refund.billId,
      orderId: bill.orderId,
      method: refund.method,
      amountXaf: refund.amountXaf,
      restocked: refund.restocked,
      approvedById: refund.approvedById,
      content: refund.snapshot as unknown as RefundDoc,
    };
  }

  private async findReplay(auth: AuthContext, key: string) {
    const found = await this.prisma.refund.findUnique({
      where: { siteId_idempotencyKey: { siteId: auth.siteId, idempotencyKey: key } },
    });
    if (!found) return null;
    if (found.createdById !== auth.userId) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Clé de requête déjà utilisée',
      });
    }
    return this.get(auth, found.id);
  }
}
