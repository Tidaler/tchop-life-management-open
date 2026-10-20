import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { type LineStatus, type Prisma, type Station } from '@tchop/db';
import { businessDay, canMoveTicket, pickText, type TicketStatusInput, type Translated } from '@tchop/shared';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { toDbDate } from '../common/counters.js';
import { notFound } from '../common/errors.js';
import { type AuthContext } from '../common/request-context.js';
import { EventsService } from '../events/events.gateway.js';
import { type KitchenTicketDoc } from '../printing/escpos.js';
import { PrintService } from '../printing/print.service.js';
import { PrismaService } from '../prisma.service.js';
import { type ModifierSnapshot } from '../orders/orders.service.js';

const ticketInclude = {
  order: { include: { table: true } },
  lines: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.KitchenTicketInclude;

type TicketRow = Prisma.KitchenTicketGetPayload<{ include: typeof ticketInclude }>;

const STATION_LABELS: Record<Station, string> = { kitchen: 'Cuisine', grill: 'Grill', bar: 'Bar' };
const LINE_STATUS: Record<TicketStatusInput['status'], LineStatus> = {
  preparing: 'preparing',
  ready: 'ready',
  served: 'served',
};

/** Bons de préparation affichés à l'écran cuisine / grill / bar. */
@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly print: PrintService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Bons en cours (non servis), du plus ancien au plus récent : ceux de la journée d'exploitation, et ceux
   * d'une commande encore ouverte. Un bon oublié d'une commande payée un autre jour ne reste pas à l'écran.
   */
  async listActive(auth: AuthContext, station?: Station) {
    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: auth.siteId } });
    const today = toDbDate(businessDay(new Date(), site.timezone, this.config.BUSINESS_DAY_CUTOFF_HOUR));
    const tickets = await this.prisma.kitchenTicket.findMany({
      where: {
        siteId: auth.siteId,
        status: { not: 'served' },
        ...(station ? { station } : {}),
        OR: [{ businessDay: { gte: today } }, { order: { status: 'open' } }],
      },
      include: ticketInclude,
      orderBy: { createdAt: 'asc' },
    });
    const waiters = await this.prisma.user.findMany({
      where: {
        id: { in: [...new Set(tickets.map((t) => t.order.waiterId).filter((id): id is string => !!id))] },
      },
      select: { id: true, displayName: true },
    });
    const names = new Map(waiters.map((w) => [w.id, w.displayName]));
    return tickets.map((t) => this.toTicket(t, t.order.waiterId ? names.get(t.order.waiterId) : undefined));
  }

  /** Fait avancer un bon (en préparation, prêt, servi) ; ses lignes suivent. */
  async updateStatus(auth: AuthContext, id: string, input: TicketStatusInput) {
    const ticket = await this.prisma.$transaction(async (tx) => {
      const current = await tx.kitchenTicket.findFirst({ where: { id, siteId: auth.siteId } });
      if (!current) throw notFound('Bon');
      if (!canMoveTicket(current.status, input.status)) {
        throw new ConflictException({
          code: 'INVALID_TRANSITION',
          message: 'Ce bon a déjà été avancé par un autre poste',
          status: current.status,
        });
      }
      const now = new Date();
      await tx.kitchenTicket.update({
        where: { id },
        data: {
          status: input.status,
          ...(input.status === 'preparing' ? { startedAt: now } : {}),
          ...(input.status === 'ready' ? { readyAt: now } : {}),
          ...(input.status === 'served' ? { servedAt: now } : {}),
        },
      });
      await tx.orderLine.updateMany({
        where: { ticketId: id, status: { not: 'cancelled' } },
        data: { status: LINE_STATUS[input.status], ...(input.status === 'served' ? { servedAt: now } : {}) },
      });
      await this.audit.log(
        {
          tenantId: auth.tenantId,
          siteId: auth.siteId,
          actorId: auth.userId,
          deviceId: auth.deviceId,
          action: 'ticket.status_changed',
          entity: 'kitchen_ticket',
          entityId: id,
          before: { status: current.status },
          after: { status: input.status },
        },
        tx,
      );
      return tx.kitchenTicket.findUniqueOrThrow({ where: { id }, include: ticketInclude });
    });

    this.events.emit(auth.siteId, { type: 'tickets.changed', ticketId: id, station: ticket.station });
    this.events.emit(auth.siteId, {
      type: 'orders.changed',
      orderId: ticket.orderId,
      tableId: ticket.order.tableId,
    });
    return this.toTicket(ticket);
  }

  /** Réimprime un bon (papier perdu, imprimante en panne au moment de l'envoi). */
  async reprint(auth: AuthContext, id: string) {
    const queued = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.kitchenTicket.findFirst({
        where: { id, siteId: auth.siteId },
        include: ticketInclude,
      });
      if (!ticket) throw notFound('Bon');
      const site = await tx.site.findUniqueOrThrow({ where: { id: auth.siteId } });
      const waiter = ticket.order.waiterId
        ? await tx.user.findUnique({ where: { id: ticket.order.waiterId } })
        : null;
      const doc: KitchenTicketDoc = {
        kind: 'kitchen_ticket',
        stationLabel: `${STATION_LABELS[ticket.station]} (réimpression)`,
        ticketNumber: ticket.number,
        orderNumber: ticket.order.number,
        tableLabel: ticket.order.table?.label ?? null,
        waiterName: waiter?.displayName ?? null,
        createdAt: ticket.createdAt.toISOString(),
        timeZone: site.timezone,
        lines: ticket.lines
          .filter((l) => l.status !== 'cancelled')
          .map((l) => ({
            quantity: l.quantity,
            name: pickText(l.name as Translated, 'fr'),
            modifiers: (l.modifiers as unknown as ModifierSnapshot[]).map((m) => pickText(m.name, 'fr')),
            note: l.note,
          })),
      };
      const count = await this.print.enqueue(tx, auth.siteId, ticket.station, doc);
      await this.audit.log(
        {
          tenantId: auth.tenantId,
          siteId: auth.siteId,
          actorId: auth.userId,
          deviceId: auth.deviceId,
          action: 'ticket.reprinted',
          entity: 'kitchen_ticket',
          entityId: id,
        },
        tx,
      );
      return count;
    });
    void this.print.processDue();
    return { queued };
  }

  private toTicket(t: TicketRow, waiterName?: string) {
    return {
      id: t.id,
      number: t.number,
      station: t.station,
      status: t.status,
      orderId: t.orderId,
      orderNumber: t.order.number,
      tableLabel: t.order.table?.label ?? null,
      waiterName: waiterName ?? null,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      readyAt: t.readyAt,
      lines: t.lines.map((l) => ({
        id: l.id,
        name: l.name as Translated,
        quantity: l.quantity,
        modifiers: (l.modifiers as unknown as ModifierSnapshot[]).map((m) => m.name),
        note: l.note,
        status: l.status,
      })),
    };
  }
}
