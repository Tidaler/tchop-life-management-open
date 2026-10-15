import { describe, expect, it } from 'vitest';
import { can, needsApproval, PERMISSIONS } from './permissions.js';
import { DEFAULT_ROLES, ROLE_CODES } from './roles.js';

describe('rôles par défaut', () => {
  it('le propriétaire a toutes les permissions sans restriction', () => {
    for (const p of PERMISSIONS) expect(DEFAULT_ROLES.owner.grants[p]).toBe('full');
  });

  it("chaque rôle n'accorde que des permissions connues", () => {
    for (const code of ROLE_CODES) {
      for (const p of Object.keys(DEFAULT_ROLES[code].grants)) expect(PERMISSIONS).toContain(p);
    }
  });

  it('un serveur ne voit pas les rapports financiers ni les paramètres', () => {
    const g = DEFAULT_ROLES.waiter.grants;
    expect(can(g, 'report.finance', 'read')).toBe(false);
    expect(can(g, 'site.settings', 'read')).toBe(false);
    expect(can(g, 'order.create')).toBe(true);
  });

  it("l'annulation après envoi demande l'approbation pour le caissier et le serveur", () => {
    expect(needsApproval(DEFAULT_ROLES.cashier.grants, 'order.line.cancel')).toBe('always');
    expect(needsApproval(DEFAULT_ROLES.waiter.grants, 'order.line.cancel')).toBe('always');
    expect(needsApproval(DEFAULT_ROLES.manager.grants, 'order.line.cancel')).toBe('never');
  });

  it('la remise du caissier est limitée par le seuil', () => {
    expect(needsApproval(DEFAULT_ROLES.cashier.grants, 'discount.apply')).toBe('over_threshold');
  });

  it("une permission en lecture seule n'autorise pas l'écriture", () => {
    const g = DEFAULT_ROLES.accountant.grants;
    expect(can(g, 'purchase.manage', 'read')).toBe(true);
    expect(can(g, 'purchase.manage', 'write')).toBe(false);
  });

  it('le gérant doit être approuvé pour rouvrir une addition payée', () => {
    expect(needsApproval(DEFAULT_ROLES.manager.grants, 'bill.reopen')).toBe('always');
  });
});

describe('formatXaf', () => {
  it('formate les montants en FCFA sans décimales', async () => {
    const { formatXaf } = await import('./money.js');
    expect(formatXaf(15000)).toBe('15 000 FCFA');
    expect(formatXaf(700.4)).toBe('700 FCFA');
    expect(formatXaf(15000, 'en')).toBe('15,000 FCFA');
  });
});
