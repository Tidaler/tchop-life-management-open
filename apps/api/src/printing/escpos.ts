import iconv from 'iconv-lite';

/** Données d'un bon de préparation, figées au moment de l'envoi (stockées dans print_job.payload). */
export interface KitchenTicketDoc {
  kind: 'kitchen_ticket' | 'kitchen_cancel';
  stationLabel: string;
  ticketNumber: number;
  orderNumber: number;
  tableLabel: string | null;
  waiterName: string | null;
  createdAt: string;
  timeZone: string;
  lines: { quantity: number; name: string; modifiers: string[]; note?: string | null }[];
  reason?: string;
}

export interface TestPageDoc {
  kind: 'test_page';
  printerName: string;
  role: string;
  createdAt: string;
  timeZone: string;
}

/** Reçu client : contenu figé au paiement (aussi conservé dans receipt.snapshot). */
export interface ReceiptDoc {
  kind: 'receipt';
  siteName: string;
  receiptNumber: number;
  orderNumber: number;
  tableLabel: string | null;
  cashierName: string;
  paidAt: string;
  timeZone: string;
  lines: { quantity: number; name: string; modifiers: string[]; amountXaf: number }[];
  subtotalXaf: number;
  discountXaf: number;
  totalXaf: number;
  payments: {
    label: string;
    amountXaf: number;
    tenderedXaf: number | null;
    changeXaf: number;
    reference: string | null;
  }[];
  reprint?: boolean;
}

/** Avoir / remboursement : contenu figé à l'émission (aussi conservé dans refund.snapshot). */
export interface RefundDoc {
  kind: 'refund';
  siteName: string;
  refundNumber: number;
  receiptNumber: number | null;
  orderNumber: number;
  tableLabel: string | null;
  cashierName: string;
  createdAt: string;
  timeZone: string;
  lines: { quantity: number; name: string; amountXaf: number }[];
  amountXaf: number;
  methodLabel: string;
  /** Avoir porté sur l'ardoise d'un client (sinon : argent rendu). */
  creditNote: boolean;
  reference: string | null;
  customerName: string | null;
  reason: string;
  restocked: boolean;
}

/** Rapport Z : clôture d'une session de caisse. */
export interface ZReportDoc {
  kind: 'z_report';
  siteName: string;
  registerName: string;
  cashierName: string;
  openedAt: string;
  closedAt: string;
  timeZone: string;
  openingFloatXaf: number;
  expected: { label: string; amountXaf: number }[];
  /** Dépenses payées avec les espèces de la caisse (absent sur les anciens rapports). */
  cashExpensesXaf?: number;
  /** Remboursements en espèces sortis de la caisse (absent sur les anciens rapports). */
  cashRefundsXaf?: number;
  expectedCashXaf: number;
  countedCashXaf: number;
  differenceXaf: number;
  comment: string | null;
  paymentCount: number;
}

export type PrintDoc = KitchenTicketDoc | TestPageDoc | ReceiptDoc | ZReportDoc | RefundDoc;

const ESC = 0x1b;
const GS = 0x1d;
const CMD = {
  init: [ESC, 0x40],
  /** Page de code 19 = PC858 (Europe de l'Ouest + €) : accents français corrects. */
  codePage: [ESC, 0x74, 19],
  alignLeft: [ESC, 0x61, 0],
  alignCenter: [ESC, 0x61, 1],
  boldOn: [ESC, 0x45, 1],
  boldOff: [ESC, 0x45, 0],
  sizeNormal: [GS, 0x21, 0x00],
  sizeDouble: [GS, 0x21, 0x11],
  sizeTall: [GS, 0x21, 0x01],
  /** Avance de quelques lignes puis coupe partielle. */
  cut: [GS, 0x56, 66, 3],
};

/** Nombre de caractères par ligne en police normale. */
export const columnsFor = (paperWidth: number) => (paperWidth <= 58 ? 32 : 48);

/** Coupe un texte en lignes de `width` caractères, sans couper les mots si possible. */
export function wrap(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
    while (current.length > width) {
      lines.push(current.slice(0, width));
      current = current.slice(width);
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

const money = (xaf: number) =>
  `${Math.round(xaf)
    .toLocaleString('fr-FR')
    .replace(/\p{Zs}/gu, ' ')} F`;

/** Ligne « libellé ........ montant » sur toute la largeur. */
const columns = (left: string, right: string, width: number) => {
  const space = width - right.length - 1;
  const l = left.length > space ? left.slice(0, space) : left;
  return `${l}${' '.repeat(Math.max(1, width - l.length - right.length))}${right}`;
};

const dateTime = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('fr-FR', { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(iso),
  );

const time = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('fr-FR', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** Construit les octets ESC/POS d'un document. */
export function renderEscPos(doc: PrintDoc, paperWidth: number): Buffer {
  const cols = columnsFor(paperWidth);
  const out: number[] = [...CMD.init, ...CMD.codePage];
  const cmd = (bytes: number[]) => out.push(...bytes);
  const text = (s: string) => out.push(...iconv.encode(s, 'cp858'), 0x0a);
  const rule = () => text('-'.repeat(cols));

  if (doc.kind === 'receipt') {
    cmd(CMD.alignCenter);
    cmd(CMD.sizeDouble);
    cmd(CMD.boldOn);
    text(doc.siteName);
    cmd(CMD.sizeNormal);
    cmd(CMD.boldOff);
    if (doc.reprint) text('*** DUPLICATA ***');
    text(`Reçu n° ${doc.receiptNumber}`);
    text(dateTime(doc.paidAt, doc.timeZone));
    text(`${doc.tableLabel ? `Table ${doc.tableLabel} · ` : ''}Cde ${doc.orderNumber} · ${doc.cashierName}`);
    cmd(CMD.alignLeft);
    rule();
    for (const line of doc.lines) {
      text(columns(`${line.quantity} x ${line.name}`, money(line.amountXaf), cols));
      for (const m of line.modifiers) wrap(`- ${m}`, cols - 4).forEach((l) => text(`    ${l}`));
    }
    rule();
    if (doc.discountXaf > 0) {
      text(columns('Sous-total', money(doc.subtotalXaf), cols));
      text(columns('Remise', `-${money(doc.discountXaf)}`, cols));
    }
    cmd(CMD.boldOn);
    cmd(CMD.sizeTall);
    text(columns('TOTAL', money(doc.totalXaf), cols));
    cmd(CMD.sizeNormal);
    cmd(CMD.boldOff);
    for (const p of doc.payments) {
      // Espèces : montant reçu et reliquat rendu toujours imprimés (reliquat à 0 F si compte juste).
      if (p.tenderedXaf !== null) {
        text(columns(`${p.label} reçues`, money(p.tenderedXaf), cols));
        text(columns('Reliquat rendu', money(p.changeXaf), cols));
        continue;
      }
      text(columns(p.reference ? `${p.label} (${p.reference})` : p.label, money(p.amountXaf), cols));
    }
    rule();
    cmd(CMD.alignCenter);
    text('Merci de votre visite !');
    text('Thank you, come again!');
    cmd(CMD.cut);
    return Buffer.from(out);
  }

  if (doc.kind === 'refund') {
    cmd(CMD.alignCenter);
    cmd(CMD.sizeDouble);
    cmd(CMD.boldOn);
    text(doc.creditNote ? 'AVOIR' : 'REMBOURSEMENT');
    cmd(CMD.sizeNormal);
    text(`N° ${doc.refundNumber}`);
    cmd(CMD.boldOff);
    text(doc.siteName);
    text(dateTime(doc.createdAt, doc.timeZone));
    text(`${doc.tableLabel ? `Table ${doc.tableLabel} · ` : ''}Cde ${doc.orderNumber} · ${doc.cashierName}`);
    if (doc.receiptNumber) text(`Reçu d'origine n° ${doc.receiptNumber}`);
    cmd(CMD.alignLeft);
    rule();
    for (const line of doc.lines)
      text(columns(`${line.quantity} x ${line.name}`, money(line.amountXaf), cols));
    if (doc.lines.length) rule();
    cmd(CMD.boldOn);
    cmd(CMD.sizeTall);
    text(columns('MONTANT', money(doc.amountXaf), cols));
    cmd(CMD.sizeNormal);
    cmd(CMD.boldOff);
    text(
      columns(
        doc.reference ? `${doc.methodLabel} (${doc.reference})` : doc.methodLabel,
        money(doc.amountXaf),
        cols,
      ),
    );
    if (doc.customerName) text(`Client : ${doc.customerName}`);
    wrap(`Motif : ${doc.reason}`, cols).forEach(text);
    if (doc.restocked) text('Marchandise remise en stock');
    rule();
    cmd(CMD.alignCenter);
    text('Signature du client :');
    text('');
    text('');
    cmd(CMD.cut);
    return Buffer.from(out);
  }

  if (doc.kind === 'z_report') {
    cmd(CMD.alignCenter);
    cmd(CMD.sizeDouble);
    cmd(CMD.boldOn);
    text('RAPPORT Z');
    cmd(CMD.sizeNormal);
    cmd(CMD.boldOff);
    text(`${doc.siteName} · ${doc.registerName}`);
    text(`Caissier : ${doc.cashierName}`);
    text(`${dateTime(doc.openedAt, doc.timeZone)} → ${dateTime(doc.closedAt, doc.timeZone)}`);
    cmd(CMD.alignLeft);
    rule();
    text(columns('Fond initial', money(doc.openingFloatXaf), cols));
    for (const e of doc.expected) text(columns(e.label, money(e.amountXaf), cols));
    text(columns('Paiements', String(doc.paymentCount), cols));
    if (doc.cashExpensesXaf) text(columns('Dépenses en caisse', `-${money(doc.cashExpensesXaf)}`, cols));
    if (doc.cashRefundsXaf) text(columns('Remboursements espèces', `-${money(doc.cashRefundsXaf)}`, cols));
    rule();
    text(columns('Espèces attendues', money(doc.expectedCashXaf), cols));
    text(columns('Espèces comptées', money(doc.countedCashXaf), cols));
    cmd(CMD.boldOn);
    text(columns('ÉCART', `${doc.differenceXaf > 0 ? '+' : ''}${money(doc.differenceXaf)}`, cols));
    cmd(CMD.boldOff);
    if (doc.comment) wrap(`Commentaire : ${doc.comment}`, cols).forEach(text);
    cmd(CMD.cut);
    return Buffer.from(out);
  }

  if (doc.kind === 'test_page') {
    cmd(CMD.alignCenter);
    cmd(CMD.sizeDouble);
    text('TidalEx Resto');
    cmd(CMD.sizeNormal);
    text("Test d'impression");
    rule();
    cmd(CMD.alignLeft);
    text(`Imprimante : ${doc.printerName}`);
    text(`Poste : ${doc.role}`);
    text(`Heure : ${time(doc.createdAt, doc.timeZone)}`);
    text('Accents : é è à ç ô û €');
    cmd(CMD.cut);
    return Buffer.from(out);
  }

  const cancel = doc.kind === 'kitchen_cancel';
  cmd(CMD.alignCenter);
  cmd(CMD.sizeDouble);
  cmd(CMD.boldOn);
  text(cancel ? '*** ANNULATION ***' : doc.stationLabel.toUpperCase());
  cmd(CMD.sizeNormal);
  if (cancel) text(doc.stationLabel.toUpperCase());
  cmd(CMD.sizeDouble);
  text(doc.tableLabel ? `Table ${doc.tableLabel}` : `Commande ${doc.orderNumber}`);
  cmd(CMD.sizeNormal);
  cmd(CMD.boldOff);
  text(`Bon n° ${doc.ticketNumber} · Cde ${doc.orderNumber} · ${time(doc.createdAt, doc.timeZone)}`);
  if (doc.waiterName) text(`Serveur : ${doc.waiterName}`);
  cmd(CMD.alignLeft);
  rule();

  for (const line of doc.lines) {
    cmd(CMD.sizeTall);
    cmd(CMD.boldOn);
    const prefix = `${line.quantity} x `;
    wrap(`${prefix}${line.name}`, cols).forEach((l, i) => text(i === 0 ? l : `    ${l}`));
    cmd(CMD.boldOff);
    cmd(CMD.sizeNormal);
    for (const m of line.modifiers) wrap(`- ${m}`, cols - 4).forEach((l) => text(`    ${l}`));
    if (line.note) wrap(`! ${line.note}`, cols - 4).forEach((l) => text(`    ${l}`));
  }
  if (cancel && doc.reason) {
    rule();
    wrap(`Motif : ${doc.reason}`, cols).forEach(text);
  }
  rule();
  cmd(CMD.cut);
  return Buffer.from(out);
}
