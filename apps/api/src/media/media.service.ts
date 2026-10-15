import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { APP_CONFIG, type AppConfig } from '../config.js';

export const MEDIA_ROUTE = '/api/media/';
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MEDIA_NAME = /^[0-9a-f-]{36}\.webp$/;
const MAX_SIDE = 800;

/**
 * Photos des produits, stockées sur le disque du serveur local.
 * Toute image est réencodée (WebP, 800 px max) : le fichier d'origine n'est jamais servi tel quel.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get dir(): string {
    return this.config.MEDIA_DIR;
  }

  async saveImage(buffer: Buffer): Promise<string> {
    let output: Buffer;
    try {
      output = await sharp(buffer, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      throw new BadRequestException({
        code: 'INVALID_IMAGE',
        message: 'Image illisible (JPEG, PNG ou WebP attendu)',
      });
    }
    const name = `${randomUUID()}.webp`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, name), output);
    return `${MEDIA_ROUTE}${name}`;
  }

  /** Supprime un fichier précédemment servi par MEDIA_ROUTE (adresse externe ou inconnue : ignorée). */
  async remove(url: string | null | undefined): Promise<void> {
    const name = url?.startsWith(MEDIA_ROUTE) ? url.slice(MEDIA_ROUTE.length) : null;
    if (!name || !MEDIA_NAME.test(name)) return;
    await rm(join(this.dir, name), { force: true }).catch((error: unknown) =>
      this.logger.warn(`Suppression impossible de ${name} : ${String(error)}`),
    );
  }

  /** Chemin du fichier à servir, ou null si le nom n'est pas celui d'un média valide. */
  resolve(name: string): string | null {
    return MEDIA_NAME.test(name) ? join(this.dir, name) : null;
  }
}
