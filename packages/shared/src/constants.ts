/**
 * Constantes et petites règles partagées, sans dépendance : utilisables par le menu client
 * et l'application du personnel sans embarquer les schémas de validation du serveur.
 */

export const LOCALES = ['fr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEVICE_KINDS = ['tablet', 'phone', 'desktop'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const STATIONS = ['kitchen', 'grill', 'bar'] as const;
export type Station = (typeof STATIONS)[number];

export const QR_MODES = ['menu', 'order'] as const;
export type QrMode = (typeof QR_MODES)[number];

export const TICKET_STATUSES = ['new', 'preparing', 'ready', 'served'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const LINE_STATUSES = ['sent', 'preparing', 'ready', 'served', 'cancelled'] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

export const PRINTER_ROLES = ['cashier', 'kitchen', 'grill', 'bar'] as const;
export type PrinterRole = (typeof PRINTER_ROLES)[number];

/** Texte affiché aux clients en français et en anglais ; l'anglais retombe sur le français s'il est vide. */
// Alias de type (pas une interface) : il reste compatible avec les colonnes JSON de Prisma.
export type Translated = { fr: string; en: string };

/** Texte dans la langue demandée, avec repli sur le français. */
export const pickText = (text: { fr: string; en?: string } | null | undefined, locale: 'fr' | 'en'): string =>
  (locale === 'en' && text?.en) || text?.fr || '';

/** Passages autorisés d'un bon : on avance toujours, on peut sauter une étape, jamais revenir en arrière. */
export function canMoveTicket(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_STATUSES.indexOf(to) > TICKET_STATUSES.indexOf(from);
}

/** Total d'une liste de lignes, hors lignes annulées. */
export function linesTotal(lines: { unitPriceXaf: number; quantity: number; status: string }[]): number {
  return lines
    .filter((l) => l.status !== 'cancelled')
    .reduce((sum, l) => sum + l.unitPriceXaf * l.quantity, 0);
}

/**
 * Journée d'exploitation : un bar ferme après minuit, donc une vente à 2 h du matin appartient
 * à la journée de la veille. Renvoie la date (AAAA-MM-JJ) dans le fuseau du site.
 */
export function businessDay(at: Date, timeZone: string, cutoffHour = 6): string {
  const shifted = new Date(at.getTime() - cutoffHour * 3_600_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(shifted);
}

/** Garde-fous du menu QR (docs/architecture/04-securite.md, « Commande par QR code »). */
export const QR_LIMITS = {
  /** Articles par demande (somme des quantités). */
  maxItems: 30,
  /** Montant maximum d'une demande. */
  maxTotalXaf: 500_000,
  /** Demandes en attente de validation pour une même table. */
  maxPendingPerTable: 3,
} as const;

/** Format d'un jeton de QR code : 128 bits en base64url (22 caractères). */
export const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Statut montré au client : il ne voit jamais le motif interne d'un refus. */
export type QrClientStatus =
  'pending' | 'accepted' | 'preparing' | 'ready' | 'served' | 'rejected' | 'expired';

export function qrClientStatus(requestStatus: string, lineStatuses: string[]): QrClientStatus {
  if (requestStatus !== 'accepted') return requestStatus as QrClientStatus;
  const live = lineStatuses.filter((s) => s !== 'cancelled');
  if (!live.length) return 'rejected';
  if (live.every((s) => s === 'served')) return 'served';
  if (live.every((s) => s === 'ready' || s === 'served')) return 'ready';
  if (live.some((s) => s !== 'sent')) return 'preparing';
  return 'accepted';
}

export const PAYMENT_METHODS = ['cash', 'mtn_momo', 'orange_money', 'card', 'customer_credit'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Moyens dont la référence de transaction est obligatoire (preuve à rapprocher du relevé de l'opérateur). */
export const REFERENCE_REQUIRED: readonly PaymentMethod[] = ['mtn_momo', 'orange_money'];

/** Moyens acceptés pour régler une ardoise (on ne rembourse pas une ardoise par une autre ardoise). */
export const SETTLEMENT_METHODS = ['cash', 'mtn_momo', 'orange_money', 'card'] as const;

/** Unités de base des articles de stock. */
export const STOCK_UNITS = ['piece', 'bottle', 'g', 'kg', 'ml', 'l'] as const;
export type StockUnit = (typeof STOCK_UNITS)[number];

export const STOCK_MOVEMENT_TYPES = [
  'receipt',
  'sale',
  'sale_cancel',
  'transfer_out',
  'transfer_in',
  'loss',
  'breakage',
  'internal_use',
  'inventory_adjustment',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/** Sorties déclarées à la main : perte, casse, consommation interne (repas du personnel, charbon…). */
export const LOSS_TYPES = ['loss', 'breakage', 'internal_use'] as const;
export type LossType = (typeof LOSS_TYPES)[number];

/** Quantité de stock arrondie au millième (précision des colonnes numeric(14,3)). */
export const roundQty = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Seuils d'approbation par défaut (paramètres du site, docs/architecture/05-roles-permissions.md) :
 * remise, perte ou casse déclarée par un rôle limité au seuil, écart net d'un inventaire (valeurs en FCFA).
 */
export const DEFAULT_THRESHOLDS = {
  discountPercent: 10,
  discountXaf: 2000,
  stockLossXaf: 10000,
  inventoryVarianceXaf: 10000,
} as const;
export type Thresholds = { -readonly [K in keyof typeof DEFAULT_THRESHOLDS]: number };

/** Montant d'une remise, plafonné au sous-total. */
export function discountAmount(
  subtotalXaf: number,
  discount: { type: 'percent' | 'amount'; value: number },
): number {
  const raw =
    discount.type === 'percent'
      ? Math.round((subtotalXaf * discount.value) / 100)
      : Math.round(discount.value);
  return Math.max(0, Math.min(subtotalXaf, raw));
}

/** Une remise dépasse le seuil si elle excède le pourcentage OU le montant autorisés sans approbation. */
export function discountOverThreshold(
  subtotalXaf: number,
  amountXaf: number,
  thresholds: { discountPercent: number; discountXaf: number } = DEFAULT_THRESHOLDS,
): boolean {
  if (amountXaf <= 0) return false;
  return amountXaf > thresholds.discountXaf || amountXaf * 100 > subtotalXaf * thresholds.discountPercent;
}
