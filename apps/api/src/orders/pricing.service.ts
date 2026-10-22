import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { type Prisma, type Station } from '@tchop/db';
import { pickText, type SendLineInput, type Translated, zonePriceXaf } from '@tchop/shared';
import { notFound } from '../common/errors.js';

export interface ModifierSnapshot {
  groupId: string;
  modifierId: string;
  name: Translated;
  priceDeltaXaf: number;
}

/** Ligne validée et chiffrée, prête à être enregistrée telle quelle (instantané de vente). */
export interface PricedLine {
  productId: string;
  name: Translated;
  unitPriceXaf: number;
  taxRateBp: number;
  quantity: number;
  modifiers: ModifierSnapshot[];
  note: string | null;
  station: Station;
}

/**
 * Contrôle et chiffrage des lignes commandées : même règles pour le personnel et pour le menu QR.
 * Le prix est toujours recalculé ici, jamais repris de ce qu'envoie l'appareil.
 */
@Injectable()
export class PricingService {
  /**
   * @param tableId table servie : dans une zone VIP, les règles VIP des catégories s'appliquent
   *   (catégorie non proposée refusée, supplément ajouté au prix).
   * @param options.publicOnly menu QR : seuls les produits et catégories visibles sur le menu public
   *   sont commandables (un produit masqué est traité comme inexistant, sans rien révéler de plus).
   */
  async price(
    tx: Prisma.TransactionClient,
    siteId: string,
    tableId: string,
    lines: SendLineInput[],
    options: { publicOnly?: boolean } = {},
  ): Promise<PricedLine[]> {
    const table = await tx.diningTable.findFirst({
      where: { id: tableId, siteId, archivedAt: null },
      include: { zone: true },
    });
    if (!table) throw notFound('Table');
    const vip = table.zone.vip;
    const ids = [...new Set(lines.map((l) => l.productId))];
    const products = await tx.product.findMany({
      where: {
        id: { in: ids },
        siteId,
        archivedAt: null,
        ...(options.publicOnly
          ? { visibleOnQr: true, category: { visibleOnQr: true, archivedAt: null } }
          : {}),
      },
      include: {
        category: true,
        modifierGroups: {
          include: { group: { include: { modifiers: { where: { archivedAt: null } } } } },
        },
      },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    return lines.map((line) => {
      const product = byId.get(line.productId);
      if (!product) throw notFound('Produit');
      const basePriceXaf = zonePriceXaf(product.priceXaf, product.category, vip);
      if (basePriceXaf === null) {
        // Menu QR : un produit absent du menu de la table est traité comme inexistant.
        if (options.publicOnly) throw notFound('Produit');
        throw new ConflictException({
          code: 'NOT_OFFERED_IN_ZONE',
          message: `${pickText(product.name as Translated, 'fr')} n'est pas proposé dans cette zone`,
          productId: product.id,
        });
      }
      if (!product.available) {
        throw new ConflictException({
          code: 'PRODUCT_UNAVAILABLE',
          message: `${pickText(product.name as Translated, 'fr')} est épuisé`,
          productId: product.id,
        });
      }
      const invalid = (message: string) =>
        new BadRequestException({ code: 'INVALID_OPTIONS', message, productId: product.id });

      const groups = product.modifierGroups.map((pg) => pg.group).filter((g) => !g.archivedAt);
      const chosen = new Set(line.modifierIds);
      const modifiers: ModifierSnapshot[] = [];
      for (const group of groups) {
        const picked = group.modifiers.filter((m) => chosen.has(m.id));
        if (picked.length < group.minSelect || picked.length > group.maxSelect) {
          throw invalid(`${pickText(group.name as Translated, 'fr')} : choix incomplet ou en trop`);
        }
        for (const m of picked) {
          if (!m.available) throw invalid(`${pickText(m.name as Translated, 'fr')} n'est plus disponible`);
          chosen.delete(m.id);
          modifiers.push({
            groupId: group.id,
            modifierId: m.id,
            name: m.name as Translated,
            priceDeltaXaf: m.priceDeltaXaf,
          });
        }
      }
      if (chosen.size > 0) throw invalid('Option inconnue pour ce produit');

      return {
        productId: product.id,
        name: product.name as Translated,
        unitPriceXaf: basePriceXaf + modifiers.reduce((s, m) => s + m.priceDeltaXaf, 0),
        taxRateBp: product.taxRateBp,
        quantity: line.quantity,
        modifiers,
        note: line.note || null,
        station: product.station,
      };
    });
  }
}
