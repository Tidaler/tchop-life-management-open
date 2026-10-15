import { existsSync } from 'node:fs';
import { Controller, Get, Optional, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public, PublicRateLimited } from '../auth/decorators.js';
import { notFound } from '../common/errors.js';
import { CloudMenuService } from '../link/cloud-menu.service.js';
import { MediaService } from './media.service.js';

@Controller('media')
export class MediaController {
  constructor(
    private readonly media: MediaService,
    // Présent seulement en mode cloud : les photos manquantes sont demandées au site.
    @Optional() private readonly cloud?: CloudMenuService,
  ) {}

  /** Photos publiques : affichées aussi sur le menu QR, où le client n'est pas connecté. */
  @Get(':name')
  @Public()
  @PublicRateLimited()
  async serve(@Param('name') name: string, @Res() res: Response): Promise<void> {
    let path = this.media.resolve(name);
    if (path && !existsSync(path)) path = this.cloud ? await this.cloud.mediaPath(name) : null;
    if (!path) throw notFound('Image');
    // Le nom du fichier change à chaque nouvelle photo : le cache peut être permanent.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.type('image/webp').sendFile(path);
  }
}
