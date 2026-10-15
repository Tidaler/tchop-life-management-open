import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { type Prisma, type Station } from '@tchop/db';
import {
  businessDay,
  type CancelLineInput,
  linesTotal,
  pickText,
  type SendOrderInput,
  type TransferOrderInput,
  type Translated,
} from '@tchop/shared';
import { ApprovalService } from '../approval/approval.service.js';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { nextCounter, toDbDate } from '../common/counters.js';
import { isUniqueViolation, notFound, versionConflict } from '../common/errors.js';
import { type AuthContext } from '../common/request-context.js';
import { EventsService } from '../events/events.gateway.js';
import { type KitchenTicketDoc } from '../printing/escpos.js';
import { PrintService } from '../printing/print.service.js';
import { PrismaService } from '../prisma.service.js';
import { type ModifierSnapshot, type PricedLine, PricingService } from './pricing.service.js';

type Tx = Prisma.TransactionClient;

export type { ModifierSnapshot } from './pricing.service.js';

const STATION_LABELS: Record<Station, string> = { kitchen: 'Cuisine', grill: 'Grill', bar: 'Bar' };

const orderInclude = {
  table: true,
  lines: { orderBy: { createdAt: 'asc' }, include: { ticket: { select: { number: true, status: true } } } },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export interface DispatchResult {
  orderId: string;
  tableId: string;
  tickets: { id: string; station: Station }[];
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approval: ApprovalService,
    private readonly events: EventsService,
    private readonly print: PrintService,
    private readonly pricing: PricingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ lecture

  /** Commandes ouvertes du site, résumées pour le plan de salle. */
  async listOpen(auth: AuthContext) {
    const orders = await this.prisma.order.findMany({
      where: { siteId: auth.siteId, status: 'open' },
      include: orderInclude,
      orderBy: { openedAt: 'asc' },
    });
    const waiters = await this.userNames(orders.map((o) => o.waiterId));
    return orders.map((o) => {
      const live = o.lines.filter((l) => l.status !== 'cancelled');
      return {
        id: o.id,
        number: o.number,
        tableId: o.tableId,
        tableLabel: o.table?.label ?? null,
        waiterName: o.waiterId ? (waiters.get(o.waiterId) ?? null) : null,
        openedAt: o.openedAt,
        total: linesTotal(o.lines),
        itemCount: live.reduce((n, l) => n + l.quantity, 0),
        readyCount: live.filter((l) => l.status === 'ready').length,
        version: o.version,
      };
    });
  }

  async get(auth: AuthContext, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, siteId: auth.siteId },
      include: orderInclude,
    });
    if (!order) throw notFound('Commande');
    return this.toDetail(order);
  }

  // ------------------------------------------------------------------ envoi

  /**
   * Envoie des articles en préparation pour une table : ouvre la commande si besoin, fige les prix,
   * crée un bon par poste et met les impressions en file. Rejouer la même clé renvoie le même résultat.
   */
  async send(auth: AuthContext, input: SendOrderInput) {
    const replay = await this.findReplay(auth, input.idempotencyKey);
    if (replay) return this.get(auth, replay);

    let result: DispatchResult;
    try {
      result = await this.prisma.$transaction((tx) => this.sendInTx(tx, auth, input), { timeout: 15_000 });
    } catch (error) {
      // Deux envois simultanés : même clé (doublon) ou même table (commande créée par l'autre).
      if (!isUniqueViolation(error)) throw error;
      const again = await this.findReplay(auth, input.idempotencyKey);
      if (again) return this.get(auth, again);
      result = await this.prisma.$transaction((tx) => this.sendInTx(tx, auth, input), { timeout: 15_000 });
    }

    this.afterDispatch(auth.siteId, result);
    return this.get(auth, result.orderId);
  }

  /** Prévient les écrans et lance l'impression, une fois la transaction validée. */
  afterDispatch(siteId: string, result: DispatchResult): void {
    this.events.emit(siteId, { type: 'orders.changed', orderId: result.orderId, tableId: result.tableId });
    for (const t of result.tickets) {
      this.events.emit(siteId, { type: 'tickets.changed', ticketId: t.id, station: t.station });
    }
    void this.print.processDue();
  }

  private async sendInTx(tx: Tx, auth: AuthContext, input: SendOrderInput): Promise<DispatchResult> {
    const priced = await this.pricing.price(tx, auth.siteId, input.lines);
    const result = await this.dispatch(tx, auth, {
      tableId: input.tableId,
      priced,
      guests: input.guests,
      source: 'staff',
    });
    await tx.idempotencyKey.create({
      data: {
        siteId: auth.siteId,
        key: input.idempotencyKey,
        userId: auth.userId,
        route: 'orders.send',
        response: { orderId: result.orderId },
      },
    });
    return result;
  }

  /**
   * Enregistre des lignes déjà chiffrées sur la commande ouverte de la table (créée si besoin),
   * crée un bon par poste et met les impressions en file. À appeler dans une transaction.
   */
  async dispatch(
    tx: Tx,
    auth: AuthContext,
    input: {
      tableId: string;
      priced: PricedLine[];
      guests?: number;
      source: 'staff' | 'qr';
      qrRequestId?: string;
    },
  ): Promise<DispatchResult> {
    const { priced } = input;
    const site = await tx.site.findUniqueOrThrow({ where: { id: auth.siteId } });
    const table = await tx.diningTable.findFirst({
      where: { id: input.tableId, siteId: auth.siteId, archivedAt: null },
    });
    if (!table) throw notFound('Table');

    const day = businessDay(new Date(), site.timezone, this.config.BUSINESS_DAY_CUTOFF_HOUR);

    let order = await tx.order.findFirst({
      where: { siteId: auth.siteId, tableId: table.id, status: 'open' },
    });
    if (!order) {
      order = await tx.order.create({
        data: {
          siteId: auth.siteId,
          number: await nextCounter(tx, auth.siteId, `order:${day}`),
          businessDay: toDbDate(day),
          tableId: table.id,
          waiterId: auth.userId,
          guests: input.guests,
          source: input.source,
        },
      });
      await this.log(tx, auth, 'order.opened', order.id, { number: order.number, table: table.label });
    }

    const waiter = await tx.user.findUnique({ where: { id: order.waiterId ?? auth.userId } });
    const byStation = new Map<Station, typeof priced>();
    for (const line of priced) byStation.set(line.station, [...(byStation.get(line.station) ?? []), line]);

    const tickets: { id: string; station: Station }[] = [];
    for (const [station, lines] of byStation) {
      const ticket = await tx.kitchenTicket.create({
        data: {
          siteId: auth.siteId,
          orderId: order.id,
          station,
          number: await nextCounter(tx, auth.siteId, `ticket:${day}`),
          businessDay: toDbDate(day),
          createdById: auth.userId,
        },
      });
      tickets.push({ id: ticket.id, station });
      await tx.orderLine.createMany({
        data: lines.map((l) => ({
          orderId: order.id,
          productId: l.productId,
          name: l.name,
          unitPriceXaf: l.unitPriceXaf,
          taxRateBp: l.taxRateBp,
          quantity: l.quantity,
          modifiers: l.modifiers as unknown as Prisma.InputJsonValue,
          note: l.note,
          station,
          ticketId: ticket.id,
          createdById: auth.userId,
          qrRequestId: input.qrRequestId,
        })),
      });
      const doc: KitchenTicketDoc = {
        kind: 'kitchen_ticket',
        stationLabel: STATION_LABELS[station],
        ticketNumber: ticket.number,
        orderNumber: order.number,
        tableLabel: table.label,
        waiterName: waiter?.displayName ?? null,
        createdAt: ticket.createdAt.toISOString(),
        timeZone: site.timezone,
        lines: lines.map((l) => ({
          quantity: l.quantity,
          name: pickText(l.name, 'fr'),
          modifiers: l.modifiers.map((m) => pickText(m.name, 'fr')),
          note: l.note,
        })),
      };
      await this.print.enqueue(tx, auth.siteId, station, doc);
    }

    await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
    await this.log(tx, auth, 'order.lines_sent', order.id, {
      source: input.source,
      qrRequestId: input.qrRequestId,
      tickets: tickets.length,
      lines: priced.map((l) => ({
        product: pickText(l.name, 'fr'),
        quantity: l.quantity,
        unitPriceXaf: l.unitPriceXaf,
      })),
    });
    return { orderId: order.id, tickets, tableId: table.id };
  }

  private async findReplay(auth: AuthContext, key: string): Promise<string | null> {
    const found = await this.prisma.idempotencyKey.findUnique({
      where: { siteId_key: { siteId: auth.siteId, key } },
    });
    if (!found) return null;
    if (found.userId !== auth.userId || found.route !== 'orders.send') {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Clé de requête déjà utilisée',
      });
    }
    return (found.response as { orderId: string }).orderId;
  }

  // ------------------------------------------------------------------ annulation

  /**
   * Annule une ligne déjà envoyée : motif obligatoire, approbation du gérant selon le rôle,
   * bon d'annulation imprimé au poste. Si plus rien n'est actif, la commande est close et la table libérée.
   */
  async cancelLine(auth: AuthContext, orderId: string, lineId: string, input: CancelLineInput) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const line = await tx.orderLine.findFirst({
        where: { id: lineId, orderId, order: { siteId: auth.siteId } },
        include: { order: { include: { table: true } }, ticket: true },
      });
      if (!line) throw notFound('Ligne de commande');
      if (line.order.status !== 'open') {
        throw new ConflictException({ code: 'ORDER_CLOSED', message: 'La commande est déjà close' });
      }
      if (line.status === 'cancelled') {
        throw new ConflictException({ code: 'ALREADY_CANCELLED', message: 'Ligne déjà annulée' });
      }

      const approverId = await this.approval.require(auth, 'order.line.cancel', input.approval, tx);
      await tx.orderLine.update({
        where: { id: lineId },
        data: {
          status: 'cancelled',
          cancelledFrom: line.status,
          cancelledAt: new Date(),
          cancelledById: auth.userId,
          approvedById: approverId,
          cancelReason: input.reason,
        },
      });

      // Prévenir le poste si le bon est encore en cours.
      if (line.ticket && line.ticket.status !== 'served') {
        const site = await tx.site.findUniqueOrThrow({ where: { id: auth.siteId } });
        const doc: KitchenTicketDoc = {
          kind: 'kitchen_cancel',
          stationLabel: STATION_LABELS[line.station],
          ticketNumber: line.ticket.number,
          orderNumber: line.order.number,
          tableLabel: line.order.table?.label ?? null,
          waiterName: null,
          createdAt: new Date().toISOString(),
          timeZone: site.timezone,
          lines: [{ quantity: line.quantity, name: pickText(line.name as Translated, 'fr'), modifiers: [] }],
          reason: input.reason,
        };
        await this.print.enqueue(tx, auth.siteId, line.station, doc);
        // Un bon dont toutes les lignes sont annulées quitte l'écran de préparation.
        const remaining = await tx.orderLine.count({
          where: { ticketId: line.ticket.id, status: { not: 'cancelled' } },
        });
        if (remaining === 0)
          await tx.kitchenTicket.update({ where: { id: line.ticket.id }, data: { status: 'served' } });
      }

      const active = await tx.orderLine.count({ where: { orderId, status: { not: 'cancelled' } } });
      if (active === 0) {
        await tx.order.update({
          where: { id: orderId },
          data: { status: 'cancelled', closedAt: new Date(), version: { increment: 1 } },
        });
      } else {
        await tx.order.update({ where: { id: orderId }, data: { version: { increment: 1 } } });
      }

      await this.audit.log(
        {
          tenantId: auth.tenantId,
          siteId: auth.siteId,
          actorId: auth.userId,
          approverId,
          deviceId: auth.deviceId,
          action: 'order.line_cancelled',
          entity: 'order_line',
          entityId: lineId,
          before: { status: line.status, quantity: line.quantity, unitPriceXaf: line.unitPriceXaf },
          reason: input.reason,
        },
        tx,
      );
      return { tableId: line.order.tableId, ticket: line.ticket, station: line.station };
    });

    this.events.emit(auth.siteId, { type: 'orders.changed', orderId, tableId: outcome.tableId });
    if (outcome.ticket) {
      this.events.emit(auth.siteId, {
        type: 'tickets.changed',
        ticketId: outcome.ticket.id,
        station: outcome.station,
      });
    }
    void this.print.processDue();
    return this.get(auth, orderId);
  }

  // ------------------------------------------------------------------ changement de table

  async transfer(auth: AuthContext, orderId: string, input: TransferOrderInput) {
    const from = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, siteId: auth.siteId },
        include: { table: true },
      });
      if (!order) throw notFound('Commande');
      if (order.status !== 'open') {
        throw new ConflictException({ code: 'ORDER_CLOSED', message: 'La commande est déjà close' });
      }
      const target = await tx.diningTable.findFirst({
        where: { id: input.tableId, siteId: auth.siteId, archivedAt: null },
      });
      if (!target) throw notFound('Table');
      if (target.id === order.tableId) return order.tableId;
      if (await tx.order.count({ where: { tableId: target.id, status: 'open' } })) {
        throw new ConflictException({
          code: 'TABLE_OCCUPIED',
          message: `La table ${target.label} est déjà occupée`,
        });
      }
      const res = await tx.order.updateMany({
        where: { id: orderId, version: input.version },
        data: { tableId: target.id, version: { increment: 1 } },
      });
      if (res.count !== 1) throw versionConflict();
      await this.log(tx, auth, 'order.transferred', orderId, { from: order.table?.label, to: target.label });
      return order.tableId;
    });
    this.events.emit(auth.siteId, { type: 'orders.changed', orderId, tableId: from });
    this.events.emit(auth.siteId, { type: 'orders.changed', orderId, tableId: input.tableId });
    return this.get(auth, orderId);
  }

  // ------------------------------------------------------------------ outils

  private async toDetail(order: OrderRow) {
    const names = await this.userNames([order.waiterId]);
    return {
      id: order.id,
      number: order.number,
      status: order.status,
      tableId: order.tableId,
      tableLabel: order.table?.label ?? null,
      waiterName: order.waiterId ? (names.get(order.waiterId) ?? null) : null,
      guests: order.guests,
      openedAt: order.openedAt,
      version: order.version,
      total: linesTotal(order.lines),
      lines: order.lines.map((l) => ({
        id: l.id,
        productId: l.productId,
        name: l.name as Translated,
        unitPriceXaf: l.unitPriceXaf,
        quantity: l.quantity,
        modifiers: l.modifiers as unknown as ModifierSnapshot[],
        note: l.note,
        station: l.station,
        status: l.status,
        ticketNumber: l.ticket?.number ?? null,
        sentAt: l.sentAt,
        cancelReason: l.cancelReason,
      })),
    };
  }

  private async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((u) => [u.id, u.displayName]));
  }

  private log(tx: Tx, auth: AuthContext, action: string, orderId: string, after?: object) {
    return this.audit.log(
      {
        tenantId: auth.tenantId,
        siteId: auth.siteId,
        actorId: auth.userId,
        deviceId: auth.deviceId,
        action,
        entity: 'order',
        entityId: orderId,
        after: after as Prisma.InputJsonValue | undefined,
      },
      tx,
    );
  }
}
