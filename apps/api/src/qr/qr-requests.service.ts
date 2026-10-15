import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type Prisma } from '@tchop/db';
import {
  QR_LIMITS,
  QR_TOKEN_PATTERN,
  qrClientStatus,
  type QrRejectInput,
  type QrSubmitInput,
  type SendLineInput,
  type Translated,
} from '@tchop/shared';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { sha256 } from '../common/crypto.js';
import { notFound } from '../common/errors.js';
import { type AuthContext } from '../common/request-context.js';
import { EventsService } from '../events/events.gateway.js';
import { type DispatchResult, OrdersService } from '../orders/orders.service.js';
import { type ModifierSnapshot, PricingService } from '../orders/pricing.service.js';
import { PrismaService } from '../prisma.service.js';

/** Ligne d'une demande QR : la saisie du client et ce qu'il a vu (nom, prix) au moment d'envoyer. */
interface RequestItem extends SendLineInput {
  name: Translated;
  unitPriceXaf: number;
  modifiers: ModifierSnapshot[];
}

/** Réponse identique pour un jeton inconnu, désactivé ou d'une table retirée : rien n'est révélé. */
const unknownQr = () => notFound('Menu');

/** Les demandes d'un client restent consultables quelques heures (le temps du repas). */
const CLIENT_HISTORY_MS = 6 * 3_600_000;

@Injectable()
export class QrRequestsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(QrRequestsService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(
      () => void this.expireStale().catch((e) => this.logger.error(String(e))),
      60_000,
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ côté client (public)

  /** QR code actif d'une table présente sur le plan, ou erreur 404 neutre. */
  async resolveQr(token: string) {
    if (!QR_TOKEN_PATTERN.test(token)) throw unknownQr();
    const qr = await this.prisma.qrCode.findUnique({
      where: { token },
      include: { table: true, site: { include: { tenant: true } } },
    });
    if (
      !qr ||
      !qr.active ||
      qr.table.archivedAt ||
      qr.site.archivedAt ||
      qr.site.tenant.status !== 'active'
    ) {
      throw unknownQr();
    }
    return qr;
  }

  /** Menu public : uniquement ce qui est visible sur le menu QR, sans aucune donnée interne. */
  async menu(token: string) {
    const qr = await this.resolveQr(token);
    const [categories, products, groups] = await Promise.all([
      this.prisma.category.findMany({
        where: { siteId: qr.siteId, archivedAt: null, visibleOnQr: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.product.findMany({
        where: {
          siteId: qr.siteId,
          archivedAt: null,
          visibleOnQr: true,
          category: { visibleOnQr: true, archivedAt: null },
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { modifierGroups: { orderBy: { sortOrder: 'asc' }, select: { groupId: true } } },
      }),
      this.prisma.modifierGroup.findMany({
        where: { siteId: qr.siteId, archivedAt: null },
        include: {
          modifiers: { where: { archivedAt: null, available: true }, orderBy: { sortOrder: 'asc' } },
        },
      }),
    ]);
    const used = new Set(products.flatMap((p) => p.modifierGroups.map((g) => g.groupId)));
    return {
      site: { name: qr.site.name },
      table: { label: qr.table.label },
      ordering: qr.mode === 'order',
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      products: products.map((p) => ({
        id: p.id,
        categoryId: p.categoryId,
        name: p.name,
        description: p.description,
        imageUrl: p.imageUrl,
        priceXaf: p.priceXaf,
        available: p.available,
        modifierGroupIds: p.modifierGroups.map((g) => g.groupId),
      })),
      modifierGroups: groups
        .filter((g) => used.has(g.id))
        .map((g) => ({
          id: g.id,
          name: g.name,
          minSelect: g.minSelect,
          maxSelect: g.maxSelect,
          modifiers: g.modifiers.map((m) => ({ id: m.id, name: m.name, priceDeltaXaf: m.priceDeltaXaf })),
        })),
    };
  }

  /**
   * Demande envoyée par un client. Elle n'atteint la cuisine qu'après validation par le personnel.
   * `clientSession` : cookie anonyme du navigateur, stocké uniquement sous forme d'empreinte.
   */
  async submit(token: string, clientSession: string, input: QrSubmitInput) {
    const qr = await this.resolveQr(token);
    if (qr.mode !== 'order') {
      throw new ForbiddenException({
        code: 'ORDERING_DISABLED',
        message: 'Ce menu est en consultation seule',
      });
    }
    const clientHash = sha256(clientSession);

    const existing = await this.prisma.qrOrderRequest.findUnique({
      where: { siteId_idempotencyKey: { siteId: qr.siteId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) {
      if (existing.clientSessionHash !== clientHash) throw unknownQr();
      return this.clientView(existing.id);
    }

    await this.expireStale();
    const request = await this.prisma.$transaction(async (tx) => {
      // Verrou sur la table : deux envois simultanés ne contournent pas la limite de demandes en attente.
      await tx.$queryRaw`SELECT 1 FROM "dining_table" WHERE "id" = ${qr.tableId}::uuid FOR UPDATE`;
      const pending = await tx.qrOrderRequest.count({ where: { tableId: qr.tableId, status: 'pending' } });
      if (pending >= QR_LIMITS.maxPendingPerTable) {
        throw new HttpException(
          { code: 'TOO_MANY_PENDING', message: 'Des commandes attendent déjà la validation du serveur' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const priced = await this.pricing.price(tx, qr.siteId, input.lines, { publicOnly: true });
      const total = priced.reduce((s, l) => s + l.unitPriceXaf * l.quantity, 0);
      if (total > QR_LIMITS.maxTotalXaf) {
        throw new HttpException(
          { code: 'ORDER_TOO_LARGE', message: 'Montant trop élevé pour une commande en ligne' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const items: RequestItem[] = input.lines.map((line, i) => ({
        ...line,
        name: priced[i]!.name,
        unitPriceXaf: priced[i]!.unitPriceXaf,
        modifiers: priced[i]!.modifiers,
      }));
      const created = await tx.qrOrderRequest.create({
        data: {
          siteId: qr.siteId,
          qrCodeId: qr.id,
          tableId: qr.tableId,
          clientSessionHash: clientHash,
          idempotencyKey: input.idempotencyKey,
          items: items as unknown as Prisma.InputJsonValue,
          totalXaf: total,
          expiresAt: new Date(Date.now() + this.config.QR_REQUEST_TTL_MINUTES * 60_000),
        },
      });
      // Aucune donnée personnelle du client n'est journalisée (ni adresse IP, ni identifiant).
      await this.audit.log(
        {
          tenantId: qr.site.tenantId,
          siteId: qr.siteId,
          action: 'qr.request_submitted',
          entity: 'qr_order_request',
          entityId: created.id,
          after: { table: qr.table.label, totalXaf: total, items: items.length },
        },
        tx,
      );
      return created;
    });

    this.events.emit(qr.siteId, { type: 'qr.changed', tableId: qr.tableId });
    return this.clientView(request.id);
  }

  /** Demandes de ce client pour cette table, avec leur avancement. */
  async clientRequests(token: string, clientSession: string | undefined) {
    const qr = await this.resolveQr(token);
    if (!clientSession) return [];
    await this.expireStale();
    const requests = await this.prisma.qrOrderRequest.findMany({
      where: {
        qrCodeId: qr.id,
        clientSessionHash: sha256(clientSession),
        createdAt: { gt: new Date(Date.now() - CLIENT_HISTORY_MS) },
      },
      orderBy: { createdAt: 'desc' },
      include: { lines: { select: { status: true } } },
    });
    return requests.map((r) => this.toClient(r));
  }

  private async clientView(id: string) {
    const r = await this.prisma.qrOrderRequest.findUniqueOrThrow({
      where: { id },
      include: { lines: { select: { status: true } } },
    });
    return this.toClient(r);
  }

  private toClient(r: Prisma.QrOrderRequestGetPayload<{ include: { lines: { select: { status: true } } } }>) {
    const items = r.items as unknown as RequestItem[];
    return {
      id: r.id,
      createdAt: r.createdAt,
      status: qrClientStatus(
        r.status,
        r.lines.map((l) => l.status),
      ),
      totalXaf: r.totalXaf,
      items: items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPriceXaf: i.unitPriceXaf,
        modifiers: i.modifiers.map((m) => m.name),
        note: i.note ?? null,
      })),
    };
  }

  // ------------------------------------------------------------------ côté personnel

  async listPending(auth: AuthContext) {
    await this.expireStale();
    const requests = await this.prisma.qrOrderRequest.findMany({
      where: { siteId: auth.siteId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
      include: { qrCode: { include: { table: true } } },
    });
    return requests.map((r) => ({
      id: r.id,
      tableId: r.tableId,
      tableLabel: r.qrCode.table.label,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      totalXaf: r.totalXaf,
      items: (r.items as unknown as RequestItem[]).map((i) => ({
        productId: i.productId,
        name: i.name,
        quantity: i.quantity,
        unitPriceXaf: i.unitPriceXaf,
        modifiers: i.modifiers.map((m) => m.name),
        note: i.note ?? null,
      })),
    }));
  }

  /**
   * Validation par le personnel : les prix et la disponibilité sont recontrôlés à ce moment,
   * puis les lignes partent en préparation comme une commande saisie par le serveur.
   */
  async accept(auth: AuthContext, id: string) {
    let result: DispatchResult;
    let tableId: string;
    try {
      ({ result, tableId } = await this.prisma.$transaction(
        async (tx) => {
          const request = await this.claim(tx, auth, id, 'accepted');
          const items = request.items as unknown as RequestItem[];
          const priced = await this.pricing.price(
            tx,
            auth.siteId,
            items.map(({ productId, quantity, modifierIds, note }) => ({
              productId,
              quantity,
              modifierIds,
              note,
            })),
          );
          const dispatched = await this.orders.dispatch(tx, auth, {
            tableId: request.tableId,
            priced,
            source: 'qr',
            qrRequestId: request.id,
          });
          await tx.qrOrderRequest.update({ where: { id }, data: { orderId: dispatched.orderId } });
          await this.log(tx, auth, 'qr.request_accepted', id, { orderId: dispatched.orderId });
          return { result: dispatched, tableId: request.tableId };
        },
        { timeout: 15_000 },
      ));
    } catch (error) {
      this.events.emit(auth.siteId, { type: 'qr.changed', tableId: null });
      throw error;
    }
    this.orders.afterDispatch(auth.siteId, result);
    this.events.emit(auth.siteId, { type: 'qr.changed', tableId });
    return { orderId: result.orderId };
  }

  /** Refus : le motif reste interne, le client voit seulement que sa commande n'a pas été acceptée. */
  async reject(auth: AuthContext, id: string, input: QrRejectInput) {
    const tableId = await this.prisma.$transaction(async (tx) => {
      const request = await this.claim(tx, auth, id, 'rejected', input.reason);
      await this.log(tx, auth, 'qr.request_rejected', id, undefined, input.reason);
      return request.tableId;
    });
    this.events.emit(auth.siteId, { type: 'qr.changed', tableId });
  }

  /** Passe une demande en attente à son nouvel état, une seule fois (deux serveurs ne la traitent pas deux fois). */
  private async claim(
    tx: Prisma.TransactionClient,
    auth: AuthContext,
    id: string,
    status: 'accepted' | 'rejected',
    rejectReason?: string,
  ) {
    const request = await tx.qrOrderRequest.findFirst({ where: { id, siteId: auth.siteId } });
    if (!request) throw notFound('Demande');
    const claimed = await tx.qrOrderRequest.updateMany({
      where: { id, status: 'pending', expiresAt: { gt: new Date() } },
      data: { status, handledById: auth.userId, handledAt: new Date(), rejectReason },
    });
    if (claimed.count !== 1) {
      throw new ConflictException({
        code: 'QR_REQUEST_CLOSED',
        message: 'Cette demande a déjà été traitée ou a expiré',
      });
    }
    return request;
  }

  /** Les demandes restées sans réponse expirent : le client est invité à appeler un serveur. */
  async expireStale(): Promise<number> {
    const expired = await this.prisma.qrOrderRequest.findMany({
      where: { status: 'pending', expiresAt: { lte: new Date() } },
      select: { id: true, siteId: true, tableId: true },
    });
    if (!expired.length) return 0;
    await this.prisma.qrOrderRequest.updateMany({
      where: { id: { in: expired.map((e) => e.id) }, status: 'pending' },
      data: { status: 'expired' },
    });
    for (const e of expired) this.events.emit(e.siteId, { type: 'qr.changed', tableId: e.tableId });
    return expired.length;
  }

  private log(
    tx: Prisma.TransactionClient,
    auth: AuthContext,
    action: string,
    id: string,
    after?: object,
    reason?: string,
  ) {
    return this.audit.log(
      {
        tenantId: auth.tenantId,
        siteId: auth.siteId,
        actorId: auth.userId,
        deviceId: auth.deviceId,
        action,
        entity: 'qr_order_request',
        entityId: id,
        after: after as Prisma.InputJsonValue | undefined,
        reason,
      },
      tx,
    );
  }
}
