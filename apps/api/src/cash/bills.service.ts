import { ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { type PaymentMethod, type Prisma } from '@tchop/db';
import {
  type ApplyDiscountInput,
  can,
  type CreateBillInput,
  DEFAULT_THRESHOLDS,
  discountAmount,
  discountOverThreshold,
  needsApproval,
  type PaymentInput,
  pickText,
  type Translated,
  type VoidPaymentInput,
} from '@tchop/shared';
import { ApprovalService } from '../approval/approval.service.js';
import { AuditService } from '../audit/audit.service.js';
import { nextCounter } from '../common/counters.js';
import { isUniqueViolation, notFound } from '../common/errors.js';
import { type AuthContext } from '../common/request-context.js';
import { EventsService } from '../events/events.gateway.js';
import { type ModifierSnapshot } from '../orders/pricing.service.js';
import { type ReceiptDoc } from '../printing/escpos.js';
import { PrintService } from '../printing/print.service.js';
import { PrismaService } from '../prisma.service.js';
import { CashService, METHOD_LABELS } from './cash.service.js';
import { assertReferenceFree } from './reference.js';

type Tx = Prisma.TransactionClient;

const billInclude = {
  lines: { include: { orderLine: true } },
  payments: { orderBy: { createdAt: 'asc' } },
  receipt: { select: { id: true, number: true } },
  order: { include: { table: true } },
} satisfies Prisma.BillInclude;
type BillRow = Prisma.BillGetPayload<{ include: typeof billInclude }>;

const live = (payments: { status: string; amountXaf: number }[]) =>
  payments.filter((p) => p.status !== 'voided').reduce((s, p) => s + p.amountXaf, 0);

const billClosed = () =>
  new ConflictException({ code: 'BILL_CLOSED', message: "L'addition est déjà réglée ou annulée" });

/**
 * Additions et encaissements. Règles : montants toujours recalculés ici, un paiement n'excède jamais
 * le reste dû (sauf espèces : la monnaie est calculée), chaque paiement porte une clé d'idempotence,
 * une référence Mobile Money ne sert qu'une fois, et l'addition soldée donne un reçu numéroté.
 */
@Injectable()
export class BillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approval: ApprovalService,
    private readonly cash: CashService,
    private readonly events: EventsService,
    private readonly print: PrintService,
  ) {}

  // ------------------------------------------------------------------ lecture

  /** Lignes d'une commande avec la quantité restant à facturer. */
  async billable(auth: AuthContext, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, siteId: auth.siteId },
      include: { table: true, lines: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) throw notFound('Commande');
    const billed = await this.billedQuantities(this.prisma, orderId);
    return {
      orderId: order.id,
      orderNumber: order.number,
      tableLabel: order.table?.label ?? null,
      status: order.status,
      lines: order.lines
        .filter((l) => l.status !== 'cancelled')
        .map((l) => ({
          id: l.id,
          name: l.name as Translated,
          modifiers: (l.modifiers as unknown as ModifierSnapshot[]).map((m) => m.name),
          unitPriceXaf: l.unitPriceXaf,
          quantity: l.quantity,
          remaining: l.quantity - (billed.get(l.id) ?? 0),
        })),
    };
  }

  /** Additions ouvertes du site (écran Caisse). */
  async listOpen(auth: AuthContext) {
    const bills = await this.prisma.bill.findMany({
      where: { siteId: auth.siteId, status: 'open' },
      include: billInclude,
      orderBy: { createdAt: 'asc' },
    });
    return bills.map((b) => this.toBill(b));
  }

  async get(auth: AuthContext, id: string) {
    const bill = await this.prisma.bill.findFirst({
      where: { id, siteId: auth.siteId },
      include: billInclude,
    });
    if (!bill) throw notFound('Addition');
    return this.toBill(bill);
  }

  // ------------------------------------------------------------------ addition

  /**
   * Crée une addition (pré-addition) pour tout ou partie des lignes. Une remise demande la permission
   * discount.apply, et l'approbation d'un gérant au-delà du seuil du site selon le rôle.
   */
  async create(auth: AuthContext, orderId: string, input: CreateBillInput) {
    const bill = await this.prisma.$transaction(async (tx) => {
      // Verrou sur la commande : deux additions simultanées ne facturent pas deux fois la même ligne.
      await tx.$queryRaw`SELECT 1 FROM "order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findFirst({
        where: { id: orderId, siteId: auth.siteId },
        include: { lines: true },
      });
      if (!order) throw notFound('Commande');
      if (order.status !== 'open') {
        throw new ConflictException({ code: 'ORDER_CLOSED', message: 'La commande est déjà close' });
      }

      const billed = await this.billedQuantities(tx, orderId);
      const lines = order.lines.filter((l) => l.status !== 'cancelled');
      const wanted = input.lines
        ? input.lines.map((w) => ({ line: lines.find((l) => l.id === w.orderLineId), quantity: w.quantity }))
        : lines.map((l) => ({ line: l, quantity: l.quantity - (billed.get(l.id) ?? 0) }));
      const selected = wanted.filter((w) => w.quantity > 0);
      for (const w of selected) {
        if (!w.line) throw notFound('Ligne de commande');
        if (w.quantity > w.line.quantity - (billed.get(w.line.id) ?? 0)) {
          throw new ConflictException({
            code: 'ALREADY_BILLED',
            message: 'Quantité déjà facturée sur une autre addition',
          });
        }
      }
      if (!selected.length) {
        throw new ConflictException({ code: 'NOTHING_TO_BILL', message: 'Tout est déjà facturé' });
      }

      const subtotal = selected.reduce((s, w) => s + w.line!.unitPriceXaf * w.quantity, 0);
      const { discount, approvedBy } = input.discount
        ? await this.checkDiscount(tx, auth, subtotal, input.discount, input.approval)
        : { discount: 0, approvedBy: null };

      const created = await tx.bill.create({
        data: {
          siteId: auth.siteId,
          orderId,
          subtotalXaf: subtotal,
          discountXaf: discount,
          discountReason: input.discount?.reason,
          discountApprovedById: approvedBy,
          totalXaf: subtotal - discount,
          createdById: auth.userId,
          lines: {
            create: selected.map((w) => ({
              orderLineId: w.line!.id,
              quantity: w.quantity,
              amountXaf: w.line!.unitPriceXaf * w.quantity,
            })),
          },
        },
      });
      await this.audit.log(
        {
          tenantId: auth.tenantId,
          siteId: auth.siteId,
          actorId: auth.userId,
          approverId: approvedBy,
          deviceId: auth.deviceId,
          action: 'bill.created',
          entity: 'bill',
          entityId: created.id,
          after: { subtotalXaf: subtotal, discountXaf: discount, totalXaf: subtotal - discount },
          reason: input.discount?.reason,
        },
        tx,
      );
      return created;
    });
    this.events.emit(auth.siteId, { type: 'bills.changed', orderId });
    return this.get(auth, bill.id);
  }

  /**
   * Remise sur une addition encore sans paiement. Permission discount.apply ; au-delà du seuil du site,
   * approbation d'un autre gérant selon le rôle. Valeur 0 : retire la remise.
   */
  async applyDiscount(auth: AuthContext, id: string, input: ApplyDiscountInput) {
    const orderId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "bill" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const bill = await tx.bill.findFirst({
        where: { id, siteId: auth.siteId },
        include: { payments: true },
      });
      if (!bill) throw notFound('Addition');
      if (bill.status !== 'open') throw billClosed();
      if (live(bill.payments) > 0) {
        throw new ConflictException({ code: 'BILL_HAS_PAYMENTS', message: "Annulez d'abord les paiements" });
      }
      const { discount, approvedBy } = await this.checkDiscount(
        tx,
        auth,
        bill.subtotalXaf,
        input.discount,
        input.approval,
      );
      await tx.bill.update({
        where: { id },
        data: {
          discountXaf: discount,
          discountReason: discount > 0 ? input.discount.reason : null,
          discountApprovedById: approvedBy,
          totalXaf: bill.subtotalXaf - discount,
          version: { increment: 1 },
        },
      });
      await this.audit.log(
        {
          tenantId: auth.tenantId,
          siteId: auth.siteId,
          actorId: auth.userId,
          approverId: approvedBy,
          deviceId: auth.deviceId,
          action: 'bill.discounted',
          entity: 'bill',
          entityId: id,
          before: { discountXaf: bill.discountXaf },
          after: { discountXaf: discount, totalXaf: bill.subtotalXaf - discount },
          reason: input.discount.reason,
        },
        tx,
      );
      return bill.orderId;
    });
    this.events.emit(auth.siteId, { type: 'bills.changed', orderId });
    return this.get(auth, id);
  }

  /** Montant de la remise et approbation éventuelle, selon le rôle et les seuils du site. */
  private async checkDiscount(
    tx: Tx,
    auth: AuthContext,
    subtotal: number,
    input: { type: 'percent' | 'amount'; value: number },
    approval: ApplyDiscountInput['approval'],
  ): Promise<{ discount: number; approvedBy: string | null }> {
    if (!can(auth.grants, 'discount.apply')) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: "Vous n'avez pas le droit d'accorder une remise",
      });
    }
    const discount = discountAmount(subtotal, input);
    const site = await tx.site.findUniqueOrThrow({ where: { id: auth.siteId } });
    const thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...((site.settings as { thresholds?: Partial<typeof DEFAULT_THRESHOLDS> }).thresholds ?? {}),
    };
    const level = needsApproval(auth.grants, 'discount.apply');
    const over =
      level === 'always' ||
      (level === 'over_threshold' && discountOverThreshold(subtotal, discount, thresholds));
    return { discount, approvedBy: over ? await this.approval.requireApprover(auth, approval, tx) : null };
  }

  /** Annule une addition sans paiement (pour la refaire autrement, par exemple séparée). */
  async void(auth: AuthContext, id: string) {
    const orderId = await this.prisma.$transaction(async (tx) => {
      const bill = await tx.bill.findFirst({
        where: { id, siteId: auth.siteId },
        include: { payments: true },
      });
      if (!bill) throw notFound('Addition');
      if (bill.status !== 'open') throw billClosed();
      if (live(bill.payments) > 0) {
        throw new ConflictException({ code: 'BILL_HAS_PAYMENTS', message: "Annulez d'abord les paiements" });
      }
      await tx.bill.update({ where: { id }, data: { status: 'voided', version: { increment: 1 } } });
      await this.log(tx, auth, 'bill.voided', id);
      return bill.orderId;
    });
    this.events.emit(auth.siteId, { type: 'bills.changed', orderId });
  }

  // ------------------------------------------------------------------ paiements

  async pay(auth: AuthContext, billId: string, input: PaymentInput) {
    const replay = await this.prisma.payment.findUnique({
      where: { siteId_idempotencyKey: { siteId: auth.siteId, idempotencyKey: input.idempotencyKey } },
    });
    if (replay) {
      if (replay.createdById !== auth.userId || replay.billId !== billId) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Clé de requête déjà utilisée',
        });
      }
      return this.get(auth, billId);
    }

    let outcome: { orderId: string; paid: boolean };
    try {
      outcome = await this.prisma.$transaction((tx) => this.payInTx(tx, auth, billId, input), {
        timeout: 15_000,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const again = await this.prisma.payment.findUnique({
          where: { siteId_idempotencyKey: { siteId: auth.siteId, idempotencyKey: input.idempotencyKey } },
        });
        if (again) return this.get(auth, billId);
        throw new ConflictException({
          code: 'REFERENCE_ALREADY_USED',
          message: 'Cette référence de transaction a déjà été enregistrée',
        });
      }
      throw error;
    }
    this.events.emit(auth.siteId, { type: 'bills.changed', orderId: outcome.orderId });
    if (outcome.paid) {
      this.events.emit(auth.siteId, { type: 'orders.changed', orderId: outcome.orderId, tableId: null });
      void this.print.processDue();
    }
    return this.get(auth, billId);
  }

  private async payInTx(tx: Tx, auth: AuthContext, billId: string, input: PaymentInput) {
    const session = await this.cash.requireOpenSession(tx, auth);
    // Verrou partagé : la session ne peut pas être clôturée pendant l'encaissement.
    await tx.$queryRaw`SELECT 1 FROM "cash_session" WHERE "id" = ${session.id}::uuid AND "status" = 'open' FOR SHARE`;
    await tx.$queryRaw`SELECT 1 FROM "bill" WHERE "id" = ${billId}::uuid FOR UPDATE`;
    const bill = await tx.bill.findFirst({
      where: { id: billId, siteId: auth.siteId },
      include: { payments: true },
    });
    if (!bill) throw notFound('Addition');
    if (bill.status !== 'open') throw billClosed();
    const remaining = bill.totalXaf - live(bill.payments);

    let amount: number;
    let change = 0;
    if (input.method === 'cash') {
      amount = Math.min(input.tenderedXaf!, remaining);
      change = input.tenderedXaf! - amount;
    } else {
      amount = input.amountXaf!;
      if (amount > remaining) {
        throw new HttpException(
          { code: 'OVERPAYMENT', message: 'Montant supérieur au reste à payer', remainingXaf: remaining },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }
    if (amount <= 0) throw billClosed();

    if (input.reference) await assertReferenceFree(tx, auth.siteId, input.method, input.reference);

    // Ardoise : client actif du site ; au-delà du plafond, approbation d'un gérant obligatoire.
    let approvedBy: string | null = null;
    if (input.method === 'customer_credit') {
      if (!can(auth.grants, 'customer_credit.charge')) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: "Vous n'avez pas le droit de mettre sur l'ardoise",
        });
      }
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, siteId: auth.siteId, active: true },
      });
      if (!customer) throw notFound('Client');
      await tx.$queryRaw`SELECT 1 FROM "customer" WHERE "id" = ${customer.id}::uuid FOR UPDATE`;
      const balance = await this.balance(tx, customer.id);
      if (balance + amount > customer.creditLimitXaf) {
        approvedBy = await this.approval.requireApprover(auth, input.approval, tx);
      }
    }

    const payment = await tx.payment.create({
      data: {
        siteId: auth.siteId,
        billId,
        sessionId: session.id,
        method: input.method,
        amountXaf: amount,
        tenderedXaf: input.method === 'cash' ? input.tenderedXaf : null,
        changeXaf: change,
        reference: input.reference ?? null,
        customerId: input.customerId ?? null,
        idempotencyKey: input.idempotencyKey,
        createdById: auth.userId,
        approvedById: approvedBy,
      },
    });
    if (input.method === 'customer_credit') {
      await tx.customerLedgerEntry.create({
        data: {
          customerId: input.customerId!,
          type: 'charge',
          amountXaf: amount,
          billId,
          paymentId: payment.id,
          sessionId: session.id,
          createdById: auth.userId,
          approvedById: approvedBy,
        },
      });
    }
    await this.audit.log(
      {
        tenantId: auth.tenantId,
        siteId: auth.siteId,
        actorId: auth.userId,
        approverId: approvedBy,
        deviceId: auth.deviceId,
        action: 'payment.recorded',
        entity: 'payment',
        entityId: payment.id,
        after: {
          billId,
          method: input.method,
          amountXaf: amount,
          changeXaf: change,
          reference: input.reference,
        },
      },
      tx,
    );

    const paid = amount >= remaining;
    if (paid) await this.finalize(tx, auth, billId);
    return { orderId: bill.orderId, paid };
  }

  /** Addition soldée : reçu numéroté (sans trou), impression, et clôture de la commande si tout est payé. */
  private async finalize(tx: Tx, auth: AuthContext, billId: string) {
    const bill = await tx.bill.update({
      where: { id: billId },
      data: { status: 'paid', paidAt: new Date(), version: { increment: 1 } },
      include: billInclude,
    });
    const site = await tx.site.findUniqueOrThrow({ where: { id: auth.siteId } });
    const cashier = await tx.user.findUniqueOrThrow({ where: { id: auth.userId } });
    const doc: ReceiptDoc = {
      kind: 'receipt',
      siteName: site.name,
      receiptNumber: await nextCounter(tx, auth.siteId, 'receipt'),
      orderNumber: bill.order.number,
      tableLabel: bill.order.table?.label ?? null,
      cashierName: cashier.displayName,
      paidAt: bill.paidAt!.toISOString(),
      timeZone: site.timezone,
      lines: bill.lines.map((l) => ({
        quantity: l.quantity,
        name: pickText(l.orderLine.name as Translated, 'fr'),
        modifiers: (l.orderLine.modifiers as unknown as ModifierSnapshot[]).map((m) =>
          pickText(m.name, 'fr'),
        ),
        amountXaf: l.amountXaf,
      })),
      subtotalXaf: bill.subtotalXaf,
      discountXaf: bill.discountXaf,
      totalXaf: bill.totalXaf,
      payments: bill.payments
        .filter((p) => p.status !== 'voided')
        .map((p) => ({
          label: METHOD_LABELS[p.method],
          amountXaf: p.amountXaf,
          tenderedXaf: p.tenderedXaf,
          changeXaf: p.changeXaf,
          reference: p.reference,
        })),
    };
    const receipt = await tx.receipt.create({
      data: {
        siteId: auth.siteId,
        number: doc.receiptNumber,
        billId,
        snapshot: doc as unknown as Prisma.InputJsonValue,
      },
    });
    await this.print.enqueue(tx, auth.siteId, 'cashier', doc);
    await this.log(tx, auth, 'bill.paid', billId, { receiptNumber: receipt.number, totalXaf: bill.totalXaf });

    // La commande est payée quand chaque ligne non annulée est entièrement facturée sur des additions payées.
    const order = await tx.order.findUniqueOrThrow({ where: { id: bill.orderId }, include: { lines: true } });
    const paidQty = await this.billedQuantities(tx, order.id, ['paid']);
    const done = order.lines
      .filter((l) => l.status !== 'cancelled')
      .every((l) => (paidQty.get(l.id) ?? 0) >= l.quantity);
    if (done && order.status === 'open') {
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'paid', closedAt: new Date(), version: { increment: 1 } },
      });
      await this.audit.log(
        {
          tenantId: auth.tenantId,
          siteId: auth.siteId,
          actorId: auth.userId,
          deviceId: auth.deviceId,
          action: 'order.paid',
          entity: 'order',
          entityId: order.id,
        },
        tx,
      );
    }
  }

  /**
   * Annule un paiement d'une addition encore ouverte (erreur de saisie). Motif obligatoire,
   * approbation selon le rôle. Une ardoise annulée est compensée par une écriture inverse.
   */
  async voidPayment(auth: AuthContext, paymentId: string, input: VoidPaymentInput) {
    const orderId = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({
        where: { id: paymentId, siteId: auth.siteId },
        include: { bill: true, session: true },
      });
      if (!payment) throw notFound('Paiement');
      if (payment.status === 'voided') {
        throw new ConflictException({ code: 'ALREADY_VOIDED', message: 'Paiement déjà annulé' });
      }
      if (payment.bill.status !== 'open') {
        throw new ConflictException({
          code: 'BILL_CLOSED',
          message: "L'addition est soldée : un remboursement est nécessaire",
        });
      }
      if (payment.session.status !== 'open') {
        throw new ConflictException({ code: 'SESSION_CLOSED', message: 'La session de caisse est clôturée' });
      }
      const approvedBy = await this.approval.require(auth, 'payment.void', input.approval, tx);
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'voided',
          voidedAt: new Date(),
          voidedById: auth.userId,
          voidReason: input.reason,
          approvedById: approvedBy ?? payment.approvedById,
        },
      });
      if (payment.method === 'customer_credit' && payment.customerId) {
        await tx.customerLedgerEntry.create({
          data: {
            customerId: payment.customerId,
            type: 'adjustment',
            amountXaf: -payment.amountXaf,
            billId: payment.billId,
            paymentId,
            createdById: auth.userId,
            approvedById: approvedBy,
            note: input.reason,
          },
        });
      }
      await this.audit.log(
        {
          tenantId: auth.tenantId,
          siteId: auth.siteId,
          actorId: auth.userId,
          approverId: approvedBy,
          deviceId: auth.deviceId,
          action: 'payment.voided',
          entity: 'payment',
          entityId: paymentId,
          before: { method: payment.method, amountXaf: payment.amountXaf },
          reason: input.reason,
        },
        tx,
      );
      return payment.bill.orderId;
    });
    this.events.emit(auth.siteId, { type: 'bills.changed', orderId });
  }

  /** Rapprochement : un paiement électronique est confirmé d'après le relevé de l'opérateur. */
  async verifyPayment(auth: AuthContext, paymentId: string) {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({ where: { id: paymentId, siteId: auth.siteId } });
      if (!payment) throw notFound('Paiement');
      if (
        payment.status !== 'recorded' ||
        payment.method === 'cash' ||
        payment.method === 'customer_credit'
      ) {
        throw new ConflictException({ code: 'NOT_VERIFIABLE', message: 'Ce paiement ne se rapproche pas' });
      }
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'verified', verifiedAt: new Date(), verifiedById: auth.userId },
      });
      await this.audit.log(
        {
          tenantId: auth.tenantId,
          siteId: auth.siteId,
          actorId: auth.userId,
          deviceId: auth.deviceId,
          action: 'payment.verified',
          entity: 'payment',
          entityId: paymentId,
        },
        tx,
      );
    });
  }

  /** Paiements électroniques à rapprocher (MoMo, Orange Money, carte). */
  async toVerify(auth: AuthContext) {
    const payments = await this.prisma.payment.findMany({
      where: {
        siteId: auth.siteId,
        status: 'recorded',
        method: { in: ['mtn_momo', 'orange_money', 'card'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return payments.map((p) => ({
      id: p.id,
      method: p.method,
      amountXaf: p.amountXaf,
      reference: p.reference,
      createdAt: p.createdAt,
    }));
  }

  /** Duplicata d'un reçu : contenu figé, mention « DUPLICATA », compteur de réimpressions. */
  async reprint(auth: AuthContext, receiptId: string) {
    await this.prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.findFirst({ where: { id: receiptId, siteId: auth.siteId } });
      if (!receipt) throw notFound('Reçu');
      await tx.receipt.update({ where: { id: receiptId }, data: { reprints: { increment: 1 } } });
      const doc = { ...(receipt.snapshot as unknown as ReceiptDoc), reprint: true };
      await this.print.enqueue(tx, auth.siteId, 'cashier', doc);
      await this.log(tx, auth, 'receipt.reprinted', receipt.billId, { receiptNumber: receipt.number });
    });
    void this.print.processDue();
  }

  async receipt(auth: AuthContext, receiptId: string) {
    const receipt = await this.prisma.receipt.findFirst({ where: { id: receiptId, siteId: auth.siteId } });
    if (!receipt) throw notFound('Reçu');
    return { id: receipt.id, number: receipt.number, reprints: receipt.reprints, content: receipt.snapshot };
  }

  // ------------------------------------------------------------------ outils

  /** Quantités déjà facturées par ligne (additions ouvertes ou payées, ou seulement payées). */
  private async billedQuantities(tx: Tx, orderId: string, statuses: ('open' | 'paid')[] = ['open', 'paid']) {
    const rows = await tx.billLine.groupBy({
      by: ['orderLineId'],
      where: { bill: { orderId, status: { in: statuses } } },
      _sum: { quantity: true },
    });
    return new Map(rows.map((r) => [r.orderLineId, r._sum.quantity ?? 0]));
  }

  async balance(tx: Tx, customerId: string): Promise<number> {
    const sum = await tx.customerLedgerEntry.aggregate({ where: { customerId }, _sum: { amountXaf: true } });
    return sum._sum.amountXaf ?? 0;
  }

  private toBill(b: BillRow) {
    const paid = live(b.payments);
    return {
      id: b.id,
      orderId: b.orderId,
      orderNumber: b.order.number,
      tableId: b.order.tableId,
      tableLabel: b.order.table?.label ?? null,
      status: b.status,
      subtotalXaf: b.subtotalXaf,
      discountXaf: b.discountXaf,
      discountReason: b.discountReason,
      totalXaf: b.totalXaf,
      paidXaf: paid,
      remainingXaf: b.status === 'open' ? Math.max(0, b.totalXaf - paid) : 0,
      createdAt: b.createdAt,
      receipt: b.receipt,
      lines: b.lines.map((l) => ({
        id: l.id,
        orderLineId: l.orderLineId,
        name: l.orderLine.name as Translated,
        modifiers: (l.orderLine.modifiers as unknown as ModifierSnapshot[]).map((m) => m.name),
        quantity: l.quantity,
        amountXaf: l.amountXaf,
      })),
      payments: b.payments.map((p) => ({
        id: p.id,
        method: p.method as PaymentMethod,
        amountXaf: p.amountXaf,
        tenderedXaf: p.tenderedXaf,
        changeXaf: p.changeXaf,
        reference: p.reference,
        status: p.status,
        createdAt: p.createdAt,
      })),
    };
  }

  private log(tx: Tx, auth: AuthContext, action: string, billId: string, after?: object) {
    return this.audit.log(
      {
        tenantId: auth.tenantId,
        siteId: auth.siteId,
        actorId: auth.userId,
        deviceId: auth.deviceId,
        action,
        entity: 'bill',
        entityId: billId,
        after: after as Prisma.InputJsonValue | undefined,
      },
      tx,
    );
  }
}
