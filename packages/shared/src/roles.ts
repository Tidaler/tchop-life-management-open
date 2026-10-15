import type { GrantLevel, Grants, Permission } from './permissions.js';

export const ROLE_CODES = [
  'owner',
  'manager',
  'cashier',
  'waiter',
  'kitchen',
  'storekeeper',
  'accountant',
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export interface RoleDefinition {
  name: { fr: string; en: string };
  /** Vrai si le rôle couvre tous les sites du client (propriétaire). */
  tenantWide: boolean;
  grants: Grants;
}

/**
 * Matrice de la section « Matrice des permissions » du document d'architecture.
 * Ordre des colonnes : propriétaire, gérant, caissier, serveur, cuisine/bar, magasinier, comptable.
 * F = ✓, A = approbation, T = seuil (≤), R = lecture (L), _ = interdit.
 */
const MATRIX: Record<Permission, string> = {
  // Salle et commandes
  'order.view': 'FFFFR__',
  'order.create': 'FFFF___',
  'qr_request.handle': 'FFFF___',
  'order.line.remove_draft': 'FFFF___',
  'order.line.cancel': 'FFAA___',
  'order.transfer': 'FFFF___',
  'bill.prepare': 'FFFF___',
  'ticket.update': 'FF_FF__',
  'product.availability': 'FF__FF_',
  'floor.manage': 'FF_____',
  // Caisse
  'cash_session.manage': 'FFF____',
  'payment.record': 'FFF____',
  'receipt.reprint': 'FFF____',
  'discount.apply': 'FFT____',
  'payment.void': 'FFA____',
  'refund.create': 'FFA____',
  'bill.reopen': 'FA_____',
  'customer_credit.charge': 'FFT____',
  'customer.manage': 'FF_____',
  'payment.verify': 'FF____F',
  // Catalogue
  'catalog.view': 'FFFFFFR',
  'catalog.edit': 'FF_____',
  'price.edit': 'FF_____',
  'recipe.edit': 'FF___R_',
  // Stocks et achats
  'stock.view': 'FF__RFR',
  'stock.item.manage': 'FF___F_',
  'stock.receive': 'FF___F_',
  'stock.transfer': 'FF___F_',
  'stock.loss': 'FF__AT_',
  'stock.count': 'FF___F_',
  'stock.adjust': 'FF___A_',
  'purchase.manage': 'FF___FR',
  // Finances et rapports
  'expense.create': 'FFT___F',
  'expense.view': 'FF____F',
  'dashboard.view': 'FF____F',
  'report.sales': 'FFR___F',
  'report.cash': 'FFR___F',
  'report.finance': 'FF____F',
  'report.stock': 'FF___FF',
  'export.accounting': 'FF____F',
  'audit.view': 'FF____R',
  // Administration
  'approval.grant': 'FF_____',
  'user.manage': 'FF_____',
  'role.manage': 'F______',
  'device.manage': 'FF_____',
  'site.settings': 'FF_____',
  'site.legal': 'F_____R',
  'remote.access': 'FF____F',
  'tenant.overview': 'F_____R',
  'tenant.billing': 'F______',
  'support.grant': 'F______',
};

const LEVELS: Record<string, GrantLevel | null> = {
  F: 'full',
  A: 'approval',
  T: 'threshold',
  R: 'read',
  _: null,
};

function grantsFor(column: number): Grants {
  const grants: Grants = {};
  for (const [permission, row] of Object.entries(MATRIX) as [Permission, string][]) {
    const level = LEVELS[row[column] ?? '_'];
    if (level) grants[permission] = level;
  }
  return grants;
}

export const DEFAULT_ROLES: Record<RoleCode, RoleDefinition> = {
  owner: { name: { fr: 'Propriétaire', en: 'Owner' }, tenantWide: true, grants: grantsFor(0) },
  manager: { name: { fr: 'Gérant', en: 'Manager' }, tenantWide: false, grants: grantsFor(1) },
  cashier: { name: { fr: 'Caissier', en: 'Cashier' }, tenantWide: false, grants: grantsFor(2) },
  waiter: { name: { fr: 'Serveur', en: 'Waiter' }, tenantWide: false, grants: grantsFor(3) },
  kitchen: { name: { fr: 'Cuisine / Bar', en: 'Kitchen / Bar' }, tenantWide: false, grants: grantsFor(4) },
  storekeeper: { name: { fr: 'Magasinier', en: 'Storekeeper' }, tenantWide: false, grants: grantsFor(5) },
  accountant: { name: { fr: 'Comptable', en: 'Accountant' }, tenantWide: false, grants: grantsFor(6) },
};

export const isRoleCode = (value: string): value is RoleCode =>
  (ROLE_CODES as readonly string[]).includes(value);
