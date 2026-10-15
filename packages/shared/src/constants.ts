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
