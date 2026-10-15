import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  adjustmentSchema,
  type AdjustmentInput,
  goodsReceiptSchema,
  type GoodsReceiptInput,
  inventoryCloseSchema,
  type InventoryCloseInput,
  inventoryCountSchema,
  type InventoryCountInput,
  inventoryStartSchema,
  type InventoryStartInput,
  locationCreateSchema,
  type LocationCreateInput,
  locationUpdateSchema,
  type LocationUpdateInput,
  lossSchema,
  type LossInput,
  movementsQuerySchema,
  type MovementsQuery,
  packagingCreateSchema,
  type PackagingCreateInput,
  purchaseOrderCreateSchema,
  type PurchaseOrderCreateInput,
  recipeSchema,
  type RecipeInput,
  stockItemCreateSchema,
  type StockItemCreateInput,
  stockItemUpdateSchema,
  type StockItemUpdateInput,
  supplierCreateSchema,
  type SupplierCreateInput,
  supplierUpdateSchema,
  type SupplierUpdateInput,
  transferSchema,
  type TransferInput,
} from '@tchop/shared';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import { type AuthContext, CurrentAuth } from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { InventoryService } from './inventory.service.js';
import { PurchasesService } from './purchases.service.js';
import { RecipesService } from './recipes.service.js';
import { StockService } from './stock.service.js';

const uuid = new ParseUUIDPipe();
const versionSchema = z.object({ version: z.number().int().positive() });
const periodSchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((p) => p.from <= p.to, { message: 'Période invalide' })
  .refine((p) => new Date(p.to).getTime() - new Date(p.from).getTime() <= 366 * 86_400_000, {
    message: 'Période limitée à un an',
  });

@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  // ---- magasins

  @Get('locations')
  @RequirePermission('stock.view', 'read')
  locations(@CurrentAuth() auth: AuthContext) {
    return this.stock.locations(auth);
  }

  @Post('locations')
  @RequirePermission('stock.item.manage')
  createLocation(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(locationCreateSchema)) body: LocationCreateInput,
  ) {
    return this.stock.createLocation(auth, body);
  }

  @Patch('locations/:id')
  @RequirePermission('stock.item.manage')
  updateLocation(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(locationUpdateSchema)) body: LocationUpdateInput,
  ) {
    return this.stock.updateLocation(auth, id, body);
  }

  // ---- articles

  @Get('items')
  @RequirePermission('stock.view', 'read')
  items(@CurrentAuth() auth: AuthContext, @Query('includeArchived') includeArchived?: string) {
    return this.stock.items(auth, includeArchived === 'true');
  }

  @Get('items/:id')
  @RequirePermission('stock.view', 'read')
  item(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.stock.item(auth, id);
  }

  @Post('items')
  @RequirePermission('stock.item.manage')
  createItem(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(stockItemCreateSchema)) body: StockItemCreateInput,
  ) {
    return this.stock.createItem(auth, body);
  }

  @Patch('items/:id')
  @RequirePermission('stock.item.manage')
  updateItem(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(stockItemUpdateSchema)) body: StockItemUpdateInput,
  ) {
    return this.stock.updateItem(auth, id, body);
  }

  @Post('items/:id/packagings')
  @RequirePermission('stock.item.manage')
  addPackaging(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(packagingCreateSchema)) body: PackagingCreateInput,
  ) {
    return this.stock.addPackaging(auth, id, body);
  }

  @Delete('items/:id/packagings/:packagingId')
  @RequirePermission('stock.item.manage')
  archivePackaging(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('packagingId', uuid) packagingId: string,
  ) {
    return this.stock.archivePackaging(auth, id, packagingId);
  }

  @Get('alerts')
  @RequirePermission('stock.view', 'read')
  alerts(@CurrentAuth() auth: AuthContext) {
    return this.stock.alerts(auth);
  }

  // ---- mouvements

  @Get('movements')
  @RequirePermission('stock.view', 'read')
  movements(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(movementsQuerySchema)) query: MovementsQuery,
  ) {
    return this.stock.movements(auth, query);
  }

  @Post('losses')
  @RequirePermission('stock.loss')
  loss(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(lossSchema)) body: LossInput) {
    return this.stock.declareLoss(auth, body);
  }

  @Post('transfers')
  @RequirePermission('stock.transfer')
  transfer(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(transferSchema)) body: TransferInput) {
    return this.stock.transfer(auth, body);
  }

  @Post('adjustments')
  @RequirePermission('stock.adjust')
  adjust(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(adjustmentSchema)) body: AdjustmentInput) {
    return this.stock.adjust(auth, body);
  }

  // ---- rapports

  @Get('valuation')
  @RequirePermission('report.stock', 'read')
  valuation(@CurrentAuth() auth: AuthContext) {
    return this.stock.valuation(auth);
  }

  @Get('report')
  @RequirePermission('report.stock', 'read')
  report(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    const period = periodSchema.safeParse(query);
    if (!period.success) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Période invalide' });
    }
    return this.stock.report(auth, period.data.from, period.data.to);
  }
}

@Controller('stock/recipes')
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @Get('missing')
  @RequirePermission('recipe.edit', 'read')
  missing(@CurrentAuth() auth: AuthContext) {
    return this.recipes.missing(auth);
  }

  @Get(':productId')
  @RequirePermission('recipe.edit', 'read')
  get(@CurrentAuth() auth: AuthContext, @Param('productId', uuid) productId: string) {
    return this.recipes.get(auth, productId);
  }

  @Put(':productId')
  @RequirePermission('recipe.edit')
  put(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', uuid) productId: string,
    @Body(new ZodPipe(recipeSchema)) body: RecipeInput,
  ) {
    return this.recipes.put(auth, productId, body);
  }
}

@Controller('stock')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get('suppliers')
  @RequirePermission('purchase.manage', 'read')
  suppliers(@CurrentAuth() auth: AuthContext, @Query('includeArchived') includeArchived?: string) {
    return this.purchases.suppliers(auth, includeArchived === 'true');
  }

  @Post('suppliers')
  @RequirePermission('purchase.manage')
  createSupplier(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(supplierCreateSchema)) body: SupplierCreateInput,
  ) {
    return this.purchases.createSupplier(auth, body);
  }

  @Patch('suppliers/:id')
  @RequirePermission('purchase.manage')
  updateSupplier(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(supplierUpdateSchema)) body: SupplierUpdateInput,
  ) {
    return this.purchases.updateSupplier(auth, id, body);
  }

  @Get('purchase-orders')
  @RequirePermission('purchase.manage', 'read')
  orders(@CurrentAuth() auth: AuthContext) {
    return this.purchases.orders(auth);
  }

  @Get('purchase-orders/:id')
  @RequirePermission('purchase.manage', 'read')
  order(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.purchases.order(auth, id);
  }

  @Post('purchase-orders')
  @RequirePermission('purchase.manage')
  createOrder(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(purchaseOrderCreateSchema)) body: PurchaseOrderCreateInput,
  ) {
    return this.purchases.createOrder(auth, body);
  }

  @Post('purchase-orders/:id/close')
  @HttpCode(200)
  @RequirePermission('purchase.manage')
  closeOrder(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(versionSchema)) body: { version: number },
  ) {
    return this.purchases.closeOrder(auth, id, body.version);
  }

  /** Réceptions : elles portent des prix d'achat, d'où la permission des rapports de stock. */
  @Get('receipts')
  @RequirePermission('report.stock', 'read')
  receipts(@CurrentAuth() auth: AuthContext) {
    return this.purchases.receipts(auth);
  }

  @Get('receipts/:id')
  @RequirePermission('report.stock', 'read')
  receipt(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.purchases.receipt(auth, id);
  }

  @Post('receipts')
  @RequirePermission('stock.receive')
  receive(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(goodsReceiptSchema)) body: GoodsReceiptInput) {
    return this.purchases.receive(auth, body);
  }
}

@Controller('stock/inventories')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermission('stock.count', 'read')
  list(@CurrentAuth() auth: AuthContext) {
    return this.inventory.list(auth);
  }

  @Get(':id')
  @RequirePermission('stock.count', 'read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string) {
    return this.inventory.get(auth, id);
  }

  @Post()
  @RequirePermission('stock.count')
  start(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(inventoryStartSchema)) body: InventoryStartInput,
  ) {
    return this.inventory.start(auth, body);
  }

  @Put(':id/counts')
  @RequirePermission('stock.count')
  count(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(inventoryCountSchema)) body: InventoryCountInput,
  ) {
    return this.inventory.count(auth, id, body);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission('stock.count')
  close(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(inventoryCloseSchema)) body: InventoryCloseInput,
  ) {
    return this.inventory.close(auth, id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('stock.count')
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(versionSchema)) body: { version: number },
  ) {
    return this.inventory.cancel(auth, id, body.version);
  }
}
