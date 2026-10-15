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

export type PrintDoc = KitchenTicketDoc | TestPageDoc;

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

const time = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('fr-FR', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** Construit les octets ESC/POS d'un document. */
export function renderEscPos(doc: PrintDoc, paperWidth: number): Buffer {
  const cols = columnsFor(paperWidth);
  const out: number[] = [...CMD.init, ...CMD.codePage];
  const cmd = (bytes: number[]) => out.push(...bytes);
  const text = (s: string) => out.push(...iconv.encode(s, 'cp858'), 0x0a);
  const rule = () => text('-'.repeat(cols));

  if (doc.kind === 'test_page') {
    cmd(CMD.alignCenter);
    cmd(CMD.sizeDouble);
    text('TCHOP LIFE');
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
