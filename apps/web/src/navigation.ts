import { type MessageKey } from '@tchop/i18n';
import { type Access, type Permission } from '@tchop/shared';

export interface Screen {
  path: string;
  label: MessageKey;
  icon: string;
  permission: Permission;
  access: Access;
  /** Phase de livraison prévue (docs/architecture/README.md). Absente : écran disponible. */
  phase?: string;
}

/** Écrans de l'application ; chacun n'apparaît que pour les rôles qui ont la permission. */
export const SCREENS: Screen[] = [
  {
    path: '/floor',
    label: 'nav.floor',
    icon: '🍽',
    permission: 'order.view',
    access: 'read',
  },
  {
    path: '/kitchen',
    label: 'nav.kitchen',
    icon: '🔥',
    permission: 'ticket.update',
    access: 'write',
  },
  {
    path: '/cashier',
    label: 'nav.cashier',
    icon: '💰',
    permission: 'payment.record',
    access: 'write',
  },
  {
    path: '/stock',
    label: 'nav.stock',
    icon: '📦',
    permission: 'stock.view',
    access: 'read',
  },
  {
    path: '/dashboard',
    label: 'nav.dashboard',
    icon: '📊',
    permission: 'dashboard.view',
    access: 'read',
    phase: 'Phase 6',
  },
  {
    path: '/availability',
    label: 'nav.availability',
    icon: '✅',
    permission: 'product.availability',
    access: 'write',
  },
  { path: '/catalog', label: 'nav.catalog', icon: '📋', permission: 'catalog.edit', access: 'write' },
  { path: '/floor-setup', label: 'nav.floorSetup', icon: '🪑', permission: 'floor.manage', access: 'write' },
  { path: '/printers', label: 'nav.printers', icon: '🖨', permission: 'site.settings', access: 'write' },
  { path: '/devices', label: 'nav.devices', icon: '📱', permission: 'device.manage', access: 'read' },
];
