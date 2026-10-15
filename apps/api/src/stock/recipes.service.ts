import { BadRequestException, Injectable } from '@nestjs/common';
import { type RecipeInput, type Translated } from '@tchop/shared';
import { notFound } from '../common/errors.js';
import { type AuthContext } from '../common/request-context.js';
import { PrismaService } from '../prisma.service.js';
import { canSeeCosts, StockService } from './stock.service.js';

/**
 * Fiches recettes : ce que chaque produit vendu sort du stock (docs/architecture/README, décision D8).
 * Une bière = 1 bouteille ; un poulet braisé = ½ poulet, plus l'accompagnement choisi.
 */
@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  async get(auth: AuthContext, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, siteId: auth.siteId },
      include: {
        recipeLines: { include: { item: true }, orderBy: { item: { name: 'asc' } } },
        modifierGroups: {
          orderBy: { sortOrder: 'asc' },
          include: {
            group: { include: { modifiers: { where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } } } },
          },
        },
      },
    });
    if (!product) throw notFound('Produit');
    const showCost = canSeeCosts(auth);
    const lines = product.recipeLines.map((l) => ({
      itemId: l.itemId,
      itemName: l.item.name,
      unit: l.item.unit,
      quantity: Number(l.quantity),
      modifierId: l.modifierId,
      ...(showCost ? { costXaf: Math.round(Number(l.quantity.times(l.item.avgCostXaf))) } : {}),
    }));
    // Coût de la portion sans option : comparé au prix de vente, il donne la marge brute estimée.
    const baseCost = lines.filter((l) => !l.modifierId).reduce((s, l) => s + (l.costXaf ?? 0), 0);
    return {
      productId: product.id,
      name: product.name as Translated,
      priceXaf: product.priceXaf,
      modifiers: product.modifierGroups
        .filter((pg) => !pg.group.archivedAt)
        .flatMap((pg) =>
          pg.group.modifiers.map((m) => ({
            id: m.id,
            name: m.name as Translated,
            group: pg.group.name as Translated,
          })),
        ),
      lines,
      ...(showCost ? { costXaf: baseCost, marginXaf: product.priceXaf - baseCost } : {}),
    };
  }

  /** Remplace la recette entière (articles du site, options du produit uniquement). */
  async put(auth: AuthContext, productId: string, input: RecipeInput) {
    await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: productId, siteId: auth.siteId, archivedAt: null },
        include: {
          recipeLines: true,
          modifierGroups: { include: { group: { include: { modifiers: { select: { id: true } } } } } },
        },
      });
      if (!product) throw notFound('Produit');

      const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
      const items = await tx.stockItem.count({
        where: { id: { in: itemIds }, siteId: auth.siteId, archivedAt: null },
      });
      if (items !== itemIds.length) throw notFound('Article');
      const allowed = new Set(product.modifierGroups.flatMap((pg) => pg.group.modifiers.map((m) => m.id)));
      if (input.lines.some((l) => l.modifierId && !allowed.has(l.modifierId))) {
        throw new BadRequestException({
          code: 'INVALID_OPTIONS',
          message: 'Option inconnue pour ce produit',
        });
      }

      await tx.recipeLine.deleteMany({ where: { productId } });
      await tx.recipeLine.createMany({ data: input.lines.map((l) => ({ productId, ...l })) });
      await this.stock.log(tx, auth, 'recipe.updated', 'product', productId, {
        before: product.recipeLines.map((l) => ({
          itemId: l.itemId,
          quantity: Number(l.quantity),
          modifierId: l.modifierId,
        })),
        after: input.lines,
      });
    });
    return this.get(auth, productId);
  }

  /** Produits en vente sans recette : leurs ventes ne sortent rien du stock. */
  async missing(auth: AuthContext) {
    const products = await this.prisma.product.findMany({
      where: { siteId: auth.siteId, archivedAt: null, recipeLines: { none: {} } },
      select: { id: true, name: true, station: true },
      orderBy: { sortOrder: 'asc' },
    });
    return products.map((p) => ({ ...p, name: p.name as Translated }));
  }
}
