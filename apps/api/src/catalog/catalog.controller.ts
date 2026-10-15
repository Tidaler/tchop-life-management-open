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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  availabilitySchema,
  type AvailabilityInput,
  categoryCreateSchema,
  type CategoryCreateInput,
  categoryUpdateSchema,
  type CategoryUpdateInput,
  modifierGroupCreateSchema,
  type ModifierGroupCreateInput,
  modifierGroupUpdateSchema,
  type ModifierGroupUpdateInput,
  productCreateSchema,
  type ProductCreateInput,
  productUpdateSchema,
  type ProductUpdateInput,
} from '@tchop/shared';
import { RequirePermission } from '../auth/decorators.js';
import { type AuthContext, CurrentAuth } from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MAX_UPLOAD_BYTES, MediaService } from '../media/media.service.js';
import { CatalogService } from './catalog.service.js';

const uuid = new ParseUUIDPipe();

@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly media: MediaService,
  ) {}

  @Get()
  @RequirePermission('catalog.view', 'read')
  get(@CurrentAuth() auth: AuthContext, @Query('includeArchived') includeArchived?: string) {
    return this.catalog.get(auth, includeArchived === 'true');
  }

  // ---- catégories

  @Post('categories')
  @RequirePermission('catalog.edit')
  createCategory(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(categoryCreateSchema)) body: CategoryCreateInput,
  ) {
    return this.catalog.createCategory(auth, body);
  }

  @Patch('categories/:id')
  @RequirePermission('catalog.edit')
  updateCategory(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(categoryUpdateSchema)) body: CategoryUpdateInput,
  ) {
    return this.catalog.updateCategory(auth, id, body);
  }

  @Post('categories/:id/archive')
  @HttpCode(204)
  @RequirePermission('catalog.edit')
  async archiveCategory(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.catalog.archiveCategory(auth, id);
  }

  // ---- produits

  @Post('products')
  @RequirePermission('catalog.edit')
  createProduct(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(productCreateSchema)) body: ProductCreateInput,
  ) {
    return this.catalog.createProduct(auth, body);
  }

  @Patch('products/:id')
  @RequirePermission('catalog.edit')
  updateProduct(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(productUpdateSchema)) body: ProductUpdateInput,
  ) {
    return this.catalog.updateProduct(auth, id, body);
  }

  @Put('products/:id/availability')
  @RequirePermission('product.availability')
  setAvailability(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(availabilitySchema)) body: AvailabilityInput,
  ) {
    return this.catalog.setAvailability(auth, id, body);
  }

  @Post('products/:id/archive')
  @HttpCode(204)
  @RequirePermission('catalog.edit')
  async archiveProduct(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.catalog.archiveProduct(auth, id);
  }

  @Post('products/:id/image')
  @RequirePermission('catalog.edit')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async uploadImage(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException({ code: 'IMAGE_REQUIRED', message: 'Aucune image reçue' });
    const url = await this.media.saveImage(file.buffer);
    try {
      const { previous, imageUrl } = await this.catalog.setImage(auth, id, url);
      await this.media.remove(previous);
      return { imageUrl };
    } catch (error) {
      await this.media.remove(url);
      throw error;
    }
  }

  @Delete('products/:id/image')
  @HttpCode(204)
  @RequirePermission('catalog.edit')
  async removeImage(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    const { previous } = await this.catalog.setImage(auth, id, null);
    await this.media.remove(previous);
  }

  // ---- options

  @Post('modifier-groups')
  @RequirePermission('catalog.edit')
  createModifierGroup(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(modifierGroupCreateSchema)) body: ModifierGroupCreateInput,
  ) {
    return this.catalog.createModifierGroup(auth, body);
  }

  @Patch('modifier-groups/:id')
  @RequirePermission('catalog.edit')
  updateModifierGroup(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(modifierGroupUpdateSchema)) body: ModifierGroupUpdateInput,
  ) {
    return this.catalog.updateModifierGroup(auth, id, body);
  }

  @Post('modifier-groups/:id/archive')
  @HttpCode(204)
  @RequirePermission('catalog.edit')
  async archiveModifierGroup(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.catalog.archiveModifierGroup(auth, id);
  }
}
