import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@tchop/db';
import { type ExportKind, type Period, pickText, type Translated } from '@tchop/shared';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { type AuthContext } from '../common/request-context.js';
import { PrismaService } from '../prisma.service.js';

type Cell = string | number | null | undefined;

/** Marque d'ordre des octets UTF-8, écrite par son code pour rester visible dans le source. */
const BOM = String.fromCharCode(0xfeff);

/**
 * Cellule CSV sûre : séparateur « ; » (Excel en français), guillemets doublés, et une valeur commençant
 * par = + - @ (ou tabulation, retour chariot) est préfixée d'une apostrophe pour qu'un tableur ne
 * l'exécute jamais comme une formule (injection CSV).
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value).replace('.', ',');
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  // BOM : Excel reconnaît l'UTF-8 (accents corrects).
  return `${BOM}${[header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

const METHODS: Record<string, string> = {
  cash: 'Espèces',
  mtn_momo: 'MTN MoMo',
  orange_money: 'Orange Money',
  card: 'Carte',
  customer_credit: 'Ardoise',
  bank_transfer: 'Virement',
};

const MOVEMENTS: Record<string, string> = {
  receipt: 'Réception',
  sale: 'Vente',
  sale_cancel: 'Annulation de vente',
  transfer_out: 'Transfert (sortie)',
  transfer_in: 'Transfert (entrée)',
  loss: 'Perte',
  breakage: 'Casse',
  internal_use: 'Consommation interne',
  inventory_adjustment: 'Ajustement',
};

/** Exports CSV pour le comptable (ventes, paiements, dépenses, mouvements de stock). */
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async export(
    auth: AuthContext,
    kind: ExportKind,
    period: Period,
  ): Promise<{ filename: string; csv: string }> {
    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: auth.siteId } });
    const cutoff = this.config.BUSINESS_DAY_CUTOFF_HOUR;
    const day = (column: string) =>
      Prisma.sql`((${Prisma.raw(column)} AT TIME ZONE ${site.timezone}) - make_interval(hours => ${cutoff}))::date`;
    const inPeriod = (column: string) =>
      Prisma.sql`${day(column)} BETWEEN ${period.from}::date AND ${period.to}::date`;
    const local = (date: Date) =>
      new Intl.DateTimeFormat('fr-FR', {
        timeZone: site.timezone,
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(date);
    const filename = `tchop-${kind}-${period.from}-${period.to}.csv`;

    if (kind === 'sales') {
      const rows = await this.prisma.$queryRaw<
        {
          day: Date;
          paid_at: Date;
          receipt: number | null;
          table: string | null;
          waiter: string | null;
          product: Translated;
          category: Translated;
          quantity: number;
          amount: number;
          discount: number;
          total: number;
          bill_id: string;
        }[]
      >`SELECT ${day('b."paid_at"')} AS day, b."paid_at", r."number" AS receipt, t."label" AS table,
               u."display_name" AS waiter, ol."name" AS product, c."name" AS category,
               bl."quantity", bl."amount_xaf" AS amount, b."discount_xaf" AS discount, b."total_xaf" AS total, b."id" AS bill_id
        FROM "bill_line" bl
        JOIN "bill" b ON b."id" = bl."bill_id"
        JOIN "order" o ON o."id" = b."order_id"
        JOIN "order_line" ol ON ol."id" = bl."order_line_id"
        JOIN "product" p ON p."id" = ol."product_id"
        JOIN "category" c ON c."id" = p."category_id"
        LEFT JOIN "receipt" r ON r."bill_id" = b."id"
        LEFT JOIN "dining_table" t ON t."id" = o."table_id"
        LEFT JOIN "user" u ON u."id" = o."waiter_id"
        WHERE b."site_id" = ${auth.siteId}::uuid AND b."status" = 'paid' AND ${inPeriod('b."paid_at"')}
        ORDER BY b."paid_at", b."id"`;
      return {
        filename,
        csv: toCsv(
          [
            'Jour',
            'Payé le',
            'Reçu n°',
            'Table',
            'Serveur',
            'Produit',
            'Catégorie',
            'Quantité',
            'Montant ligne (FCFA)',
            'Remise addition (FCFA)',
            'Total addition (FCFA)',
          ],
          rows.map((r) => [
            r.day.toISOString().slice(0, 10),
            local(r.paid_at),
            r.receipt,
            r.table,
            r.waiter,
            pickText(r.product, 'fr'),
            pickText(r.category, 'fr'),
            Number(r.quantity),
            Number(r.amount),
            Number(r.discount),
            Number(r.total),
          ]),
        ),
      };
    }

    if (kind === 'payments') {
      const rows = await this.prisma.$queryRaw<
        {
          created_at: Date;
          receipt: number | null;
          method: string;
          amount: number;
          tendered: number | null;
          change: number;
          reference: string | null;
          status: string;
          cashier: string | null;
          register: string;
        }[]
      >`SELECT pm."created_at", r."number" AS receipt, pm."method"::text AS method, pm."amount_xaf" AS amount,
               pm."tendered_xaf" AS tendered, pm."change_xaf" AS change, pm."reference", pm."status"::text AS status,
               u."display_name" AS cashier, cr."name" AS register
        FROM "payment" pm
        JOIN "cash_session" cs ON cs."id" = pm."session_id"
        JOIN "cash_register" cr ON cr."id" = cs."register_id"
        LEFT JOIN "user" u ON u."id" = cs."cashier_id"
        LEFT JOIN "receipt" r ON r."bill_id" = pm."bill_id"
        WHERE pm."site_id" = ${auth.siteId}::uuid AND ${inPeriod('pm."created_at"')}
        ORDER BY pm."created_at"`;
      const status: Record<string, string> = {
        recorded: 'Enregistré',
        verified: 'Rapproché',
        voided: 'Annulé',
      };
      return {
        filename,
        csv: toCsv(
          [
            'Date',
            'Reçu n°',
            'Moyen',
            'Montant (FCFA)',
            'Remis (FCFA)',
            'Monnaie (FCFA)',
            'Référence',
            'Statut',
            'Caissier',
            'Caisse',
          ],
          rows.map((r) => [
            local(r.created_at),
            r.receipt,
            METHODS[r.method] ?? r.method,
            Number(r.amount),
            r.tendered === null ? null : Number(r.tendered),
            Number(r.change),
            r.reference,
            status[r.status] ?? r.status,
            r.cashier,
            r.register,
          ]),
        ),
      };
    }

    if (kind === 'expenses') {
      const rows = await this.prisma.expense.findMany({
        where: {
          siteId: auth.siteId,
          businessDay: { gte: new Date(`${period.from}T00:00:00Z`), lte: new Date(`${period.to}T00:00:00Z`) },
        },
        include: { category: true },
        orderBy: [{ businessDay: 'asc' }, { number: 'asc' }],
      });
      const users = await this.prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } },
        select: { id: true, displayName: true },
      });
      const names = new Map(users.map((u) => [u.id, u.displayName]));
      return {
        filename,
        csv: toCsv(
          [
            'Jour',
            'N°',
            'Catégorie',
            'Nature',
            'Description',
            'Montant (FCFA)',
            'Moyen',
            'Payée depuis la caisse',
            'Référence',
            'Statut',
            "Motif d'annulation",
            'Saisie par',
          ],
          rows.map((r) => [
            r.businessDay.toISOString().slice(0, 10),
            r.number,
            r.category.name,
            r.category.kind === 'purchase' ? 'Achat de marchandises' : 'Charge',
            r.description,
            r.amountXaf,
            METHODS[r.method] ?? r.method,
            r.sessionId ? 'Oui' : 'Non',
            r.reference,
            r.status === 'voided' ? 'Annulée' : 'Enregistrée',
            r.voidReason,
            names.get(r.createdById) ?? null,
          ]),
        ),
      };
    }

    const rows = await this.prisma.$queryRaw<
      {
        created_at: Date;
        type: string;
        item: string;
        unit: string;
        location: string;
        quantity: Prisma.Decimal;
        unit_cost: Prisma.Decimal;
        reason: string | null;
        user: string | null;
      }[]
    >`SELECT m."created_at", m."type"::text AS type, i."name" AS item, i."unit"::text AS unit, l."name" AS location,
             m."quantity", m."unit_cost_xaf" AS unit_cost, m."reason", u."display_name" AS user
      FROM "stock_movement" m
      JOIN "stock_item" i ON i."id" = m."item_id"
      JOIN "stock_location" l ON l."id" = m."location_id"
      LEFT JOIN "user" u ON u."id" = m."created_by"
      WHERE m."site_id" = ${auth.siteId}::uuid AND ${inPeriod('m."created_at"')}
      ORDER BY m."created_at", m."id"`;
    return {
      filename,
      csv: toCsv(
        [
          'Date',
          'Type',
          'Article',
          'Unité',
          'Magasin',
          'Quantité',
          'Coût unitaire (FCFA)',
          'Valeur (FCFA)',
          'Motif',
          'Par',
        ],
        rows.map((r) => [
          local(r.created_at),
          MOVEMENTS[r.type] ?? r.type,
          r.item,
          r.unit,
          r.location,
          Number(r.quantity),
          Math.round(Number(r.unit_cost) * 100) / 100,
          Math.round(Number(r.quantity) * Number(r.unit_cost)),
          r.reason,
          r.user,
        ]),
      ),
    };
  }
}
