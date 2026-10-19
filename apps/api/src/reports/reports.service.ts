import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@tchop/db';
import { businessDay, can, type Period, type Translated } from '@tchop/shared';
import { CashService } from '../cash/cash.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { type AuthContext } from '../common/request-context.js';
import { PrismaService } from '../prisma.service.js';
import { StockService } from '../stock/stock.service.js';

const n = (v: unknown): number => Number(v ?? 0);

/** Tous les jours de la période : un jour sans vente reste visible (à zéro) sur l'axe du temps. */
function everyDay(period: Period): string[] {
  const days: string[] = [];
  const day = new Date(`${period.from}T00:00:00Z`);
  while (day.toISOString().slice(0, 10) <= period.to) {
    days.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return days;
}

/**
 * Pilotage : tableau de bord, rapports de ventes, de caisse et financier.
 * Une vente compte le jour d'exploitation de son paiement (addition soldée), bascule à l'heure du site.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cash: CashService,
    private readonly stock: StockService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Jour d'exploitation d'un instant, calculé par PostgreSQL (fuseau et heure de bascule du site). */
  private async context(auth: AuthContext) {
    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: auth.siteId } });
    const cutoff = this.config.BUSINESS_DAY_CUTOFF_HOUR;
    const day = (column: string) =>
      Prisma.sql`((${Prisma.raw(column)} AT TIME ZONE ${site.timezone}) - make_interval(hours => ${cutoff}))::date`;
    return { site, day, today: businessDay(new Date(), site.timezone, cutoff) };
  }

  async today(auth: AuthContext): Promise<string> {
    return (await this.context(auth)).today;
  }

  // ------------------------------------------------------------------ ventes

  /**
   * Ventes de la période : totaux, par jour, catégorie, produit, serveur et moyen de paiement.
   * Un caissier en lecture seule ne voit que les additions encaissées dans ses propres sessions.
   */
  async sales(auth: AuthContext, period: Period) {
    const { day } = await this.context(auth);
    const ownOnly = !can(auth.grants, 'report.sales', 'write');
    const own = ownOnly
      ? Prisma.sql`AND b."id" IN (SELECT pm."bill_id" FROM "payment" pm JOIN "cash_session" cs ON cs."id" = pm."session_id"
                     WHERE cs."cashier_id" = ${auth.userId}::uuid)`
      : Prisma.empty;
    const paid = Prisma.sql`b."site_id" = ${auth.siteId}::uuid AND b."status" = 'paid'
      AND ${day('b."paid_at"')} BETWEEN ${period.from}::date AND ${period.to}::date ${own}`;

    const [totals] = await this.prisma.$queryRaw<
      { bills: bigint; gross: bigint; discount: bigint; net: bigint }[]
    >`SELECT count(*) AS bills, coalesce(sum(b."subtotal_xaf"), 0) AS gross,
             coalesce(sum(b."discount_xaf"), 0) AS discount, coalesce(sum(b."total_xaf"), 0) AS net
      FROM "bill" b WHERE ${paid}`;

    const byDay = await this.prisma.$queryRaw<{ day: Date; bills: bigint; net: bigint }[]>`
      SELECT ${day('b."paid_at"')} AS day, count(*) AS bills, sum(b."total_xaf") AS net
      FROM "bill" b WHERE ${paid} GROUP BY 1 ORDER BY 1`;

    const lines = await this.prisma.$queryRaw<
      {
        product_id: string;
        product: Translated;
        category_id: string;
        category: Translated;
        quantity: bigint;
        amount: bigint;
      }[]
    >`SELECT p."id" AS product_id, p."name" AS product, c."id" AS category_id, c."name" AS category,
             sum(bl."quantity") AS quantity, sum(bl."amount_xaf") AS amount
      FROM "bill_line" bl
      JOIN "bill" b ON b."id" = bl."bill_id"
      JOIN "order_line" ol ON ol."id" = bl."order_line_id"
      JOIN "product" p ON p."id" = ol."product_id"
      JOIN "category" c ON c."id" = p."category_id"
      WHERE ${paid}
      GROUP BY p."id", p."name", c."id", c."name"`;

    const byWaiter = await this.prisma.$queryRaw<
      { waiter_id: string | null; name: string | null; bills: bigint; net: bigint }[]
    >`
      SELECT o."waiter_id", u."display_name" AS name, count(*) AS bills, sum(b."total_xaf") AS net
      FROM "bill" b JOIN "order" o ON o."id" = b."order_id" LEFT JOIN "user" u ON u."id" = o."waiter_id"
      WHERE ${paid} GROUP BY 1, 2 ORDER BY net DESC`;

    const byMethod = await this.prisma.$queryRaw<{ method: string; count: bigint; amount: bigint }[]>`
      SELECT pm."method"::text AS method, count(*) AS count, sum(pm."amount_xaf") AS amount
      FROM "payment" pm JOIN "bill" b ON b."id" = pm."bill_id"
      WHERE ${paid} AND pm."status" <> 'voided' GROUP BY 1 ORDER BY amount DESC`;

    // Commandes et annulations : vue d'ensemble, réservée à qui voit toutes les ventes.
    let orders: number | null = null;
    let cancellations: { lines: number; amountXaf: number } | null = null;
    if (!ownOnly) {
      orders = await this.prisma.order.count({
        where: {
          siteId: auth.siteId,
          status: { not: 'cancelled' },
          businessDay: { gte: new Date(`${period.from}T00:00:00Z`), lte: new Date(`${period.to}T00:00:00Z`) },
        },
      });
      const [c] = await this.prisma.$queryRaw<{ lines: bigint; amount: bigint }[]>`
        SELECT count(*) AS lines, coalesce(sum(ol."quantity" * ol."unit_price_xaf"), 0) AS amount
        FROM "order_line" ol JOIN "order" o ON o."id" = ol."order_id"
        WHERE o."site_id" = ${auth.siteId}::uuid AND ol."status" = 'cancelled' AND ol."cancelled_at" IS NOT NULL
          AND ${day('ol."cancelled_at"')} BETWEEN ${period.from}::date AND ${period.to}::date`;
      cancellations = { lines: n(c?.lines), amountXaf: n(c?.amount) };
    }

    const categories = new Map<
      string,
      { id: string; name: Translated; quantity: number; amountXaf: number }
    >();
    for (const l of lines) {
      const cat = categories.get(l.category_id) ?? {
        id: l.category_id,
        name: l.category,
        quantity: 0,
        amountXaf: 0,
      };
      cat.quantity += n(l.quantity);
      cat.amountXaf += n(l.amount);
      categories.set(l.category_id, cat);
    }
    // Remboursements émis dans la période (caissier : ceux de ses propres sessions).
    const [refunds] = await this.prisma.$queryRaw<{ count: bigint; amount: bigint | null }[]>`
      SELECT count(*) AS count, sum(r."amount_xaf") AS amount FROM "refund" r
      WHERE r."site_id" = ${auth.siteId}::uuid
        AND ${day('r."created_at"')} BETWEEN ${period.from}::date AND ${period.to}::date
        ${ownOnly ? Prisma.sql`AND r."session_id" IN (SELECT "id" FROM "cash_session" WHERE "cashier_id" = ${auth.userId}::uuid)` : Prisma.empty}`;

    const bills = n(totals?.bills);
    const net = n(totals?.net);
    const refundsXaf = n(refunds?.amount);
    return {
      period,
      ownOnly,
      totals: {
        bills,
        grossXaf: n(totals?.gross),
        discountXaf: n(totals?.discount),
        netXaf: net,
        refunds: n(refunds?.count),
        refundsXaf,
        /** Chiffre d'affaires net des remboursements. */
        revenueXaf: net - refundsXaf,
        averageTicketXaf: bills ? Math.round(net / bills) : 0,
        orders,
      },
      cancellations,
      byDay: everyDay(period).map((dayKey) => {
        const d = byDay.find((x) => x.day.toISOString().slice(0, 10) === dayKey);
        return { day: dayKey, bills: n(d?.bills), netXaf: n(d?.net) };
      }),
      byCategory: [...categories.values()].sort((a, b) => b.amountXaf - a.amountXaf),
      byProduct: lines
        .map((l) => ({
          id: l.product_id,
          name: l.product,
          category: l.category,
          quantity: n(l.quantity),
          amountXaf: n(l.amount),
        }))
        .sort((a, b) => b.amountXaf - a.amountXaf),
      byWaiter: byWaiter.map((w) => ({ id: w.waiter_id, name: w.name, bills: n(w.bills), netXaf: n(w.net) })),
      byMethod: byMethod.map((m) => ({ method: m.method, count: n(m.count), amountXaf: n(m.amount) })),
    };
  }

  // ------------------------------------------------------------------ caisse

  /** Sessions de caisse ouvertes dans la période, avec théorique, compté et écart. Caissier : les siennes. */
  async cashReport(auth: AuthContext, period: Period) {
    const { day } = await this.context(auth);
    const ownOnly = !can(auth.grants, 'report.cash', 'write');
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT cs."id" FROM "cash_session" cs
      WHERE cs."site_id" = ${auth.siteId}::uuid
        AND ${day('cs."opened_at"')} BETWEEN ${period.from}::date AND ${period.to}::date
        ${ownOnly ? Prisma.sql`AND cs."cashier_id" = ${auth.userId}::uuid` : Prisma.empty}
      ORDER BY cs."opened_at" DESC`;
    const sessions = [];
    for (const { id } of ids) sessions.push(await this.cash.summary(id));
    const closed = sessions.filter((s) => s.status === 'closed');
    const toVerify = await this.prisma.payment.count({
      where: {
        siteId: auth.siteId,
        status: 'recorded',
        method: { in: ['mtn_momo', 'orange_money', 'card'] },
        ...(ownOnly ? { session: { cashierId: auth.userId } } : {}),
      },
    });
    return {
      period,
      ownOnly,
      sessions,
      totals: {
        sessions: sessions.length,
        open: sessions.length - closed.length,
        differenceXaf: closed.reduce((s, x) => s + (x.differenceXaf ?? 0), 0),
        cashExpensesXaf: sessions.reduce((s, x) => s + x.cashExpensesXaf, 0),
      },
      paymentsToVerify: toVerify,
    };
  }

  // ------------------------------------------------------------------ finances

  /**
   * Résultat estimé : chiffre d'affaires − coût des marchandises vendues (recettes au coût moyen) − pertes
   * − charges. Les achats de marchandises sont des sorties d'argent, pas des charges de la période
   * (leur coût entre par les ventes) : ils sont montrés à part. Ce n'est pas un résultat comptable.
   */
  async finance(auth: AuthContext, period: Period) {
    const { day } = await this.context(auth);
    const sales = await this.sales(auth, period);
    const inPeriod = (column: string) =>
      Prisma.sql`${day(column)} BETWEEN ${period.from}::date AND ${period.to}::date`;

    const [stock] = await this.prisma.$queryRaw<
      { cogs: Prisma.Decimal | null; losses: Prisma.Decimal | null }[]
    >`
      SELECT
        -sum(CASE WHEN m."type" IN ('sale', 'sale_cancel') THEN m."quantity" * m."unit_cost_xaf" END) AS cogs,
        -sum(CASE WHEN m."type" IN ('loss', 'breakage', 'internal_use') THEN m."quantity" * m."unit_cost_xaf" END) AS losses
      FROM "stock_movement" m
      WHERE m."site_id" = ${auth.siteId}::uuid AND ${inPeriod('m."created_at"')}`;

    const expenses = await this.prisma.$queryRaw<
      { id: string; name: string; kind: string; amount: bigint }[]
    >`
      SELECT c."id", c."name", c."kind"::text AS kind, sum(e."amount_xaf") AS amount
      FROM "expense" e JOIN "expense_category" c ON c."id" = e."category_id"
      WHERE e."site_id" = ${auth.siteId}::uuid AND e."status" = 'recorded'
        AND e."business_day" BETWEEN ${period.from}::date AND ${period.to}::date
      GROUP BY 1, 2, 3 ORDER BY amount DESC`;

    const [received] = await this.prisma.$queryRaw<{ amount: bigint | null }[]>`
      SELECT sum(r."total_xaf") AS amount FROM "goods_receipt" r
      WHERE r."site_id" = ${auth.siteId}::uuid AND ${inPeriod('r."created_at"')}`;

    // Fiabilité : un produit vendu sans recette n'a pas de coût, la marge est alors surestimée.
    const [noRecipe] = await this.prisma.$queryRaw<{ products: bigint; amount: bigint | null }[]>`
      SELECT count(DISTINCT p."id") AS products, sum(bl."amount_xaf") AS amount
      FROM "bill_line" bl JOIN "bill" b ON b."id" = bl."bill_id"
      JOIN "order_line" ol ON ol."id" = bl."order_line_id" JOIN "product" p ON p."id" = ol."product_id"
      WHERE b."site_id" = ${auth.siteId}::uuid AND b."status" = 'paid' AND ${inPeriod('b."paid_at"')}
        AND NOT EXISTS (SELECT 1 FROM "recipe_line" r WHERE r."product_id" = p."id")`;

    const revenue = sales.totals.revenueXaf;
    const cogs = Math.round(n(stock?.cogs));
    const losses = Math.round(n(stock?.losses));
    const operating = expenses.filter((e) => e.kind === 'operating');
    const purchases = expenses.filter((e) => e.kind === 'purchase');
    const operatingXaf = operating.reduce((s, e) => s + n(e.amount), 0);
    const grossMarginXaf = revenue - cogs;
    return {
      period,
      revenueXaf: revenue,
      costOfSalesXaf: cogs,
      grossMarginXaf,
      grossMarginRate: revenue ? Math.round((grossMarginXaf / revenue) * 1000) / 10 : null,
      lossesXaf: losses,
      operatingExpensesXaf: operatingXaf,
      operatingExpenses: operating.map((e) => ({ id: e.id, name: e.name, amountXaf: n(e.amount) })),
      estimatedProfitXaf: grossMarginXaf - losses - operatingXaf,
      purchaseExpensesXaf: purchases.reduce((s, e) => s + n(e.amount), 0),
      goodsReceivedXaf: n(received?.amount),
      salesWithoutRecipe: { products: n(noRecipe?.products), amountXaf: n(noRecipe?.amount) },
    };
  }

  // ------------------------------------------------------------------ tableau de bord

  /** Tableau de bord : la journée (ou la période) en un coup d'œil. */
  async dashboard(auth: AuthContext, period?: Period) {
    const range = period ?? { from: await this.today(auth), to: await this.today(auth) };
    const sales = await this.sales(auth, range);
    const expenses = await this.prisma.expense.aggregate({
      where: {
        siteId: auth.siteId,
        status: 'recorded',
        businessDay: { gte: new Date(`${range.from}T00:00:00Z`), lte: new Date(`${range.to}T00:00:00Z`) },
      },
      _sum: { amountXaf: true },
      _count: true,
    });
    const openSessions = await this.prisma.cashSession.findMany({
      where: { siteId: auth.siteId, status: 'open' },
      select: { id: true },
    });
    const sessions = [];
    for (const s of openSessions) sessions.push(await this.cash.summary(s.id));
    const alerts = can(auth.grants, 'stock.view', 'read') ? await this.stock.alerts(auth) : [];
    const openOrders = await this.prisma.order.count({ where: { siteId: auth.siteId, status: 'open' } });
    const toVerify = await this.prisma.payment.count({
      where: {
        siteId: auth.siteId,
        status: 'recorded',
        method: { in: ['mtn_momo', 'orange_money', 'card'] },
      },
    });
    return {
      period: range,
      sales: sales.totals,
      byCategory: sales.byCategory.slice(0, 8),
      topProducts: sales.byProduct.slice(0, 5),
      byMethod: sales.byMethod,
      byDay: sales.byDay,
      expenses: { totalXaf: expenses._sum.amountXaf ?? 0, count: expenses._count },
      cashSessions: sessions.map((s) => ({
        id: s.id,
        register: s.register.name,
        cashier: s.cashierName,
        openedAt: s.openedAt,
        collectedXaf: Object.values(s.byMethod).reduce((a, b) => a + b, 0),
        expectedCashXaf: s.expectedCashXaf,
      })),
      openOrders,
      paymentsToVerify: toVerify,
      stockAlerts: { count: alerts.length, items: alerts.slice(0, 6) },
    };
  }
}
