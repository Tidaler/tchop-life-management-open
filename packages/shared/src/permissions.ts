/**
 * Permissions élémentaires. Source : docs/architecture/05-roles-permissions.md.
 * L'API vérifie toujours ces permissions ; l'interface ne fait que masquer ce qui n'est pas autorisé.
 */
export const PERMISSIONS = [
  // Salle et commandes
  'order.view',
  'order.create',
  'qr_request.handle',
  'order.line.remove_draft',
  'order.line.cancel',
  'order.transfer',
  'bill.prepare',
  'ticket.update',
  'product.availability',
  'floor.manage',
  // Caisse
  'cash_session.manage',
  'payment.record',
  'receipt.reprint',
  'discount.apply',
  'payment.void',
  'refund.create',
  'bill.reopen',
  'customer_credit.charge',
  'customer.manage',
  'payment.verify',
  // Catalogue
  'catalog.view',
  'catalog.edit',
  'price.edit',
  'recipe.edit',
  // Stocks et achats
  'stock.view',
  'stock.receive',
  'stock.transfer',
  'stock.loss',
  'stock.count',
  'stock.adjust',
  'purchase.manage',
  // Finances et rapports
  'expense.create',
  'expense.view',
  'dashboard.view',
  'report.sales',
  'report.cash',
  'report.finance',
  'report.stock',
  'export.accounting',
  'audit.view',
  // Administration
  'approval.grant',
  'user.manage',
  'role.manage',
  'device.manage',
  'site.settings',
  'site.legal',
  'remote.access',
  'tenant.overview',
  'tenant.billing',
  'support.grant',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const isPermission = (value: string): value is Permission =>
  (PERMISSIONS as readonly string[]).includes(value);

/**
 * Niveau d'accès accordé par un rôle pour une permission (colonnes de la matrice) :
 * - `full` (✓) : autorisé ;
 * - `approval` (A) : autorisé, avec approbation d'un gérant au moment de l'action ;
 * - `threshold` (≤) : autorisé jusqu'au seuil du site, approbation au-delà ;
 * - `read` (L) : consultation seulement.
 */
export const GRANT_LEVELS = ['full', 'approval', 'threshold', 'read'] as const;
export type GrantLevel = (typeof GRANT_LEVELS)[number];

export type Grants = Partial<Record<Permission, GrantLevel>>;

export type Access = 'read' | 'write';

/** Vrai si les droits permettent l'accès demandé. Un niveau `read` ne permet que la lecture. */
export function can(grants: Grants, permission: Permission, access: Access = 'write'): boolean {
  const level = grants[permission];
  if (!level) return false;
  return access === 'read' || level !== 'read';
}

/** Vrai si l'action, bien qu'autorisée, demande l'approbation d'un gérant (toujours ou au-delà d'un seuil). */
export function needsApproval(grants: Grants, permission: Permission): 'always' | 'over_threshold' | 'never' {
  const level = grants[permission];
  if (level === 'approval') return 'always';
  if (level === 'threshold') return 'over_threshold';
  return 'never';
}
