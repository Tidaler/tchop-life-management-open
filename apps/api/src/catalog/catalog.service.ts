import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { type Prisma } from '@tchop/db';
import {
  can,
  type AvailabilityInput,
  type CategoryCreateInput,
  type CategoryUpdateInput,
  type ModifierGroupCreateInput,
  type ModifierGroupUpdateInput,
  type ProductCreateInput,
  type ProductUpdateInput,
} from '@tchop/shared';
import { AuditService } from '../audit/audit.service.js';
import { notFound, versionConflict } from '../common/errors.js';
import { EventsService } from '../events/events.gateway.js';
import { type AuthContext } from '../common/request-context.js';
import { PrismaService } from '../prisma.service.js';

type Tx = Prisma.TransactionClient;

const productInclude = {
  modifierGroups: { orderBy: { sortOrder: 'asc' }, select: { groupId: true } },
} satisfies Prisma.ProductInclude;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

const toProduct = (p: ProductRow) => ({
  id: p.id,
  categoryId: p.categoryId,
  name: p.name,
  description: p.description,
  imageUrl: p.imageUrl,
  priceXaf: p.priceXaf,
  taxRateBp: p.taxRateBp,
  station: p.station,
  available: p.available,
  visibleOnQr: p.visibleOnQr,
  sortOrder: p.sortOrder,
  version: p.version,
  archivedAt: p.archivedAt,
  modifierGroupIds: p.modifierGroups.map((g) => g.groupId),
});

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  /** Catalogue complet du site (hors éléments archivés, sauf demande contraire). */
  async get(auth: AuthContext, includeArchived = false) {
    const live = includeArchived ? {} : { archivedAt: null };
    const [categories, products, groups] = await Promise.all([
      this.prisma.category.findMany({
        where: { siteId: auth.siteId, ...live },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.product.findMany({
        where: { siteId: auth.siteId, ...live },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: productInclude,
      }),
      this.prisma.modifierGroup.findMany({
        where: { siteId: auth.siteId, ...live },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { modifiers: { where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } } },
      }),
    ]);
    return {
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        visibleOnQr: c.visibleOnQr,
        sortOrder: c.sortOrder,
        version: c.version,
        archivedAt: c.archivedAt,
      })),
      products: products.map(toProduct),
      modifierGroups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        version: g.version,
        archivedAt: g.archivedAt,
        modifiers: g.modifiers.map((m) => ({
          id: m.id,
          name: m.name,
          priceDeltaXaf: m.priceDeltaXaf,
          available: m.available,
        })),
      })),
    };
  }

  // ------------------------------------------------------------------ catégories

  async createCategory(auth: AuthContext, input: CategoryCreateInput) {
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.create({ data: { siteId: auth.siteId, ...input } });
      await this.log(tx, auth, 'catalog.category_created', 'category', category.id, undefined, input);
      return category;
    });
  }

  async updateCategory(auth: AuthContext, id: string, input: CategoryUpdateInput) {
    const { version, ...data } = input;
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.category.findFirst({ where: { id, siteId: auth.siteId, archivedAt: null } });
      if (!before) throw notFound('Catégorie');
      await this.bumpVersion(
        tx.category.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } }),
      );
      const after = await tx.category.findUniqueOrThrow({ where: { id } });
      await this.log(tx, auth, 'catalog.category_updated', 'category', id, pick(before, data), data);
      return after;
    });
  }

  /** Archive une catégorie vide. Les produits doivent d'abord être déplacés ou archivés. */
  async archiveCategory(auth: AuthContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const category = await tx.category.findFirst({ where: { id, siteId: auth.siteId, archivedAt: null } });
      if (!category) throw notFound('Catégorie');
      const products = await tx.product.count({ where: { categoryId: id, archivedAt: null } });
      if (products > 0) {
        throw new BadRequestException({
          code: 'CATEGORY_NOT_EMPTY',
          message: 'La catégorie contient encore des produits',
        });
      }
      await tx.category.update({
        where: { id },
        data: { archivedAt: new Date(), version: { increment: 1 } },
      });
      await this.log(tx, auth, 'catalog.category_archived', 'category', id);
    });
  }

  // ------------------------------------------------------------------ produits

  async createProduct(auth: AuthContext, input: ProductCreateInput) {
    const { modifierGroupIds, ...data } = input;
    return this.prisma.$transaction(async (tx) => {
      await this.assertCategory(tx, auth, data.categoryId);
      await this.assertGroups(tx, auth, modifierGroupIds);
      const product = await tx.product.create({
        data: {
          siteId: auth.siteId,
          ...data,
          description: data.description ?? undefined,
          modifierGroups: { create: modifierGroupIds.map((groupId, sortOrder) => ({ groupId, sortOrder })) },
        },
        include: productInclude,
      });
      await this.log(tx, auth, 'catalog.product_created', 'product', product.id, undefined, input);
      return toProduct(product);
    });
  }

  /** Modifie un produit. Changer le prix demande en plus la permission `price.edit`. */
  async updateProduct(auth: AuthContext, id: string, input: ProductUpdateInput) {
    const { version, modifierGroupIds, ...data } = input;
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.product.findFirst({
        where: { id, siteId: auth.siteId, archivedAt: null },
        include: productInclude,
      });
      if (!before) throw notFound('Produit');

      if (
        data.priceXaf !== undefined &&
        data.priceXaf !== before.priceXaf &&
        !can(auth.grants, 'price.edit')
      ) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: "Vous n'avez pas le droit de modifier un prix",
        });
      }
      if (data.categoryId) await this.assertCategory(tx, auth, data.categoryId);
      if (modifierGroupIds) await this.assertGroups(tx, auth, modifierGroupIds);

      await this.bumpVersion(
        tx.product.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } }),
      );
      if (modifierGroupIds) {
        await tx.productModifierGroup.deleteMany({ where: { productId: id } });
        await tx.productModifierGroup.createMany({
          data: modifierGroupIds.map((groupId, sortOrder) => ({ productId: id, groupId, sortOrder })),
        });
      }
      const after = await tx.product.findUniqueOrThrow({ where: { id }, include: productInclude });

      const changed = { ...data, ...(modifierGroupIds ? { modifierGroupIds } : {}) };
      await this.log(
        tx,
        auth,
        'catalog.product_updated',
        'product',
        id,
        pick(toProduct(before), changed),
        changed,
      );
      if (data.priceXaf !== undefined && data.priceXaf !== before.priceXaf) {
        await this.log(
          tx,
          auth,
          'catalog.price_changed',
          'product',
          id,
          { priceXaf: before.priceXaf },
          { priceXaf: data.priceXaf },
        );
      }
      return toProduct(after);
    });
  }

  /** Disponible / épuisé : réservé au service (cuisine, bar, gérant), sans verrou de version. */
  async setAvailability(auth: AuthContext, id: string, input: AvailabilityInput) {
    const result = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({ where: { id, siteId: auth.siteId, archivedAt: null } });
      if (!product) throw notFound('Produit');
      if (product.available === input.available) return { id, available: product.available };
      await tx.product.update({
        where: { id },
        data: { available: input.available, version: { increment: 1 } },
      });
      await this.log(
        tx,
        auth,
        'catalog.availability_changed',
        'product',
        id,
        { available: product.available },
        input,
      );
      return { id, available: input.available };
    });
    // Les tablettes des serveurs grisent aussitôt le produit épuisé.
    this.events.emit(auth.siteId, { type: 'catalog.changed' });
    return result;
  }

  async archiveProduct(auth: AuthContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({ where: { id, siteId: auth.siteId, archivedAt: null } });
      if (!product) throw notFound('Produit');
      await tx.product.update({ where: { id }, data: { archivedAt: new Date(), version: { increment: 1 } } });
      await this.log(tx, auth, 'catalog.product_archived', 'product', id);
    });
  }

  /** Enregistre l'adresse de la photo du produit (fichier déjà stocké par MediaService). */
  async setImage(auth: AuthContext, id: string, imageUrl: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({ where: { id, siteId: auth.siteId, archivedAt: null } });
      if (!product) throw notFound('Produit');
      await tx.product.update({ where: { id }, data: { imageUrl, version: { increment: 1 } } });
      await this.log(
        tx,
        auth,
        'catalog.image_changed',
        'product',
        id,
        { imageUrl: product.imageUrl },
        { imageUrl },
      );
      return { previous: product.imageUrl, imageUrl };
    });
  }

  // ------------------------------------------------------------------ options

  async createModifierGroup(auth: AuthContext, input: ModifierGroupCreateInput) {
    return this.prisma.$transaction(async (tx) => {
      if (input.modifiers.some((m) => m.id)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Nouvelles options sans identifiant',
        });
      }
      const group = await tx.modifierGroup.create({
        data: {
          siteId: auth.siteId,
          name: input.name,
          minSelect: input.minSelect,
          maxSelect: input.maxSelect,
          modifiers: {
            create: input.modifiers.map(({ id: _id, ...m }, sortOrder) => ({ ...m, sortOrder })),
          },
        },
      });
      await this.log(
        tx,
        auth,
        'catalog.modifier_group_created',
        'modifier_group',
        group.id,
        undefined,
        input,
      );
      return group;
    });
  }

  /**
   * Remplace la liste des options du groupe : options existantes modifiées, nouvelles créées,
   * absentes archivées (elles restent lisibles dans l'historique des ventes).
   */
  async updateModifierGroup(auth: AuthContext, id: string, input: ModifierGroupUpdateInput) {
    const { version, modifiers, ...data } = input;
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.modifierGroup.findFirst({
        where: { id, siteId: auth.siteId, archivedAt: null },
        include: { modifiers: { where: { archivedAt: null } } },
      });
      if (!before) throw notFound("Groupe d'options");
      const known = new Set(before.modifiers.map((m) => m.id));
      if (modifiers.some((m) => m.id && !known.has(m.id))) throw notFound('Option');

      await this.bumpVersion(
        tx.modifierGroup.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } }),
      );
      const kept = new Set<string>();
      for (const [sortOrder, { id: modifierId, ...m }] of modifiers.entries()) {
        if (modifierId) {
          kept.add(modifierId);
          await tx.modifier.update({ where: { id: modifierId }, data: { ...m, sortOrder } });
        } else {
          const created = await tx.modifier.create({ data: { groupId: id, ...m, sortOrder } });
          kept.add(created.id);
        }
      }
      await tx.modifier.updateMany({
        where: { groupId: id, archivedAt: null, id: { notIn: [...kept] } },
        data: { archivedAt: new Date() },
      });
      await this.log(
        tx,
        auth,
        'catalog.modifier_group_updated',
        'modifier_group',
        id,
        { name: before.name, minSelect: before.minSelect, maxSelect: before.maxSelect },
        { ...data, modifiers: modifiers.length },
      );
      return tx.modifierGroup.findUniqueOrThrow({ where: { id } });
    });
  }

  async archiveModifierGroup(auth: AuthContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const group = await tx.modifierGroup.findFirst({
        where: { id, siteId: auth.siteId, archivedAt: null },
      });
      if (!group) throw notFound("Groupe d'options");
      await tx.productModifierGroup.deleteMany({ where: { groupId: id } });
      await tx.modifierGroup.update({
        where: { id },
        data: { archivedAt: new Date(), version: { increment: 1 } },
      });
      await this.log(tx, auth, 'catalog.modifier_group_archived', 'modifier_group', id);
    });
  }

  // ------------------------------------------------------------------ outils

  private async assertCategory(tx: Tx, auth: AuthContext, categoryId: string) {
    const found = await tx.category.count({
      where: { id: categoryId, siteId: auth.siteId, archivedAt: null },
    });
    if (!found) throw notFound('Catégorie');
  }

  private async assertGroups(tx: Tx, auth: AuthContext, ids: string[]) {
    if (!ids.length) return;
    const found = await tx.modifierGroup.count({
      where: { id: { in: ids }, siteId: auth.siteId, archivedAt: null },
    });
    if (found !== new Set(ids).size) throw notFound("Groupe d'options");
  }

  /** Une mise à jour conditionnée par la version qui ne touche aucune ligne signale un conflit. */
  private async bumpVersion(update: Promise<{ count: number }>) {
    if ((await update).count !== 1) throw versionConflict();
  }

  private log(
    tx: Tx,
    auth: AuthContext,
    action: string,
    entity: string,
    entityId: string,
    before?: unknown,
    after?: unknown,
  ) {
    return this.audit.log(
      {
        tenantId: auth.tenantId,
        siteId: auth.siteId,
        actorId: auth.userId,
        deviceId: auth.deviceId,
        action,
        entity,
        entityId,
        before: before as Prisma.InputJsonValue | undefined,
        after: after as Prisma.InputJsonValue | undefined,
      },
      tx,
    );
  }
}

/** Valeurs « avant » des seuls champs modifiés, pour le journal d'audit. */
function pick(source: object, changes: object): Record<string, unknown> {
  const record = source as Record<string, unknown>;
  return Object.fromEntries(Object.keys(changes).map((k) => [k, record[k]]));
}
