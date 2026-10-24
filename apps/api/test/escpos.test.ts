import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
// Fonctions de l'API compilée (voir helpers.ts).
import { type ReceiptDoc, renderEscPos } from '../dist/printing/escpos.js';

const receipt = (payments: ReceiptDoc['payments']): ReceiptDoc => ({
  kind: 'receipt',
  siteName: 'TCHOP LIFE',
  receiptNumber: 12,
  orderNumber: 5,
  tableLabel: 'T3',
  cashierName: 'Mireille',
  paidAt: '2026-10-24T12:00:00.000Z',
  timeZone: 'Africa/Douala',
  lines: [{ quantity: 3, name: 'Castel', modifiers: [], amountXaf: 3000 }],
  subtotalXaf: 3000,
  discountXaf: 0,
  totalXaf: 3000,
  payments,
});
const print = (doc: ReceiptDoc, paperWidth = 80) => iconv.decode(renderEscPos(doc, paperWidth), 'cp858');

describe('reçu de paiement', () => {
  it('espèces : montant reçu et reliquat rendu', () => {
    const text = print(
      receipt([{ label: 'Espèces', amountXaf: 3000, tenderedXaf: 5000, changeXaf: 2000, reference: null }]),
    );
    expect(text).toMatch(/Espèces reçues +5 000 F/);
    expect(text).toMatch(/Reliquat rendu +2 000 F/);
  });

  it('compte juste : reliquat à 0 F, toujours imprimé', () => {
    const text = print(
      receipt([{ label: 'Espèces', amountXaf: 3000, tenderedXaf: 3000, changeXaf: 0, reference: null }]),
      58,
    );
    expect(text).toMatch(/Reliquat rendu +0 F/);
    // Papier de 58 mm : 32 caractères par ligne.
    // (les commandes ESC/POS de mise en forme qui précèdent une ligne ne sont pas imprimées)
    const lines = text.match(/(Espèces reçues|Reliquat rendu).*/g) ?? [];
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toHaveLength(32);
  });

  it('paiement en deux fois : la part mobile n’a pas de reliquat', () => {
    const text = print(
      receipt([
        { label: 'Espèces', amountXaf: 1000, tenderedXaf: 1000, changeXaf: 0, reference: null },
        { label: 'MTN MoMo', amountXaf: 2000, tenderedXaf: null, changeXaf: 0, reference: 'MP123' },
      ]),
    );
    expect(text).toMatch(/MTN MoMo \(MP123\) +2 000 F/);
    expect(text.match(/Reliquat rendu/g)).toHaveLength(1);
  });
});
