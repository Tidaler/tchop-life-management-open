/**
 * Menu en texte, contenu dans des QR codes : le client scanne et lit la carte sans Internet ni Wi-Fi
 * (le téléphone affiche le texte du QR code). Un QR code contient au plus environ 3 000 octets ;
 * on découpe la carte en plusieurs QR codes plus petits, plus faciles à lire, sans couper une catégorie.
 */
export interface TextMenuCategory {
  id: string;
  name: { fr: string };
}
export interface TextMenuProduct {
  categoryId: string;
  name: { fr: string };
  priceXaf: number;
}
export interface TextMenuPart {
  /** Catégories de ce QR code, pour la légende imprimée sous le QR. */
  categories: string[];
  text: string;
}

/** Taille visée par QR code : version 15 à 20 environ, lisible à 6 cm par n'importe quel téléphone. */
export const TEXT_MENU_MAX_BYTES = 900;

const bytes = (s: string) => new TextEncoder().encode(s).length;
/** 2500 -> « 2 500 » (espace simple : un octet, quel que soit le téléphone). */
const price = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function textMenuParts(
  menu: { categories: TextMenuCategory[]; products: TextMenuProduct[] },
  options: { title: string; maxBytes?: number },
): TextMenuPart[] {
  const max = options.maxBytes ?? TEXT_MENU_MAX_BYTES;
  const blocks = menu.categories
    .map((c) => {
      const items = menu.products.filter((p) => p.categoryId === c.id);
      const lines = items.map((p) => `${p.name.fr} : ${price(p.priceXaf)}`);
      return {
        name: c.name.fr,
        text: `\n${c.name.fr.toUpperCase()}\n${lines.join('\n')}\n`,
        count: items.length,
      };
    })
    .filter((b) => b.count > 0);

  const footer = '\nPrix en FCFA. Commande auprès du personnel.';
  // En-tête le plus long possible (« (12/12) ») pour ne jamais dépasser la limite après numérotation.
  const room = max - bytes(`${options.title} (12/12)\n`) - bytes(footer);
  // Nombre de QR codes nécessaire, puis remplissage équilibré : des QR codes de taille voisine, tous aussi
  // faciles à lire (sans jamais dépasser la limite ni couper une catégorie).
  const total = blocks.reduce((n, b) => n + bytes(b.text), 0);
  const target = Math.min(room, Math.ceil(total / Math.max(1, Math.ceil(total / room))));
  const groups: { names: string[]; text: string }[] = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    const size = last ? bytes(last.text) : 0;
    const fits = last && size + bytes(block.text) <= room;
    // On remplit jusqu'à la cible ; au-delà, nouveau QR code si le bloc tient mieux dans le suivant.
    if (fits && (size + bytes(block.text) <= target || size < target / 2)) {
      last.names.push(block.name);
      last.text += block.text;
    } else {
      groups.push({ names: [block.name], text: block.text });
    }
  }
  return groups.map((g, i) => ({
    categories: g.names,
    text: `${options.title}${groups.length > 1 ? ` (${i + 1}/${groups.length})` : ''}\n${g.text}${footer}`,
  }));
}
