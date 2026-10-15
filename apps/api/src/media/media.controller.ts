import { existsSync } from 'node:fs';
import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators.js';
import { notFound } from '../common/errors.js';
import { MediaService } from './media.service.js';

@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** Photos publiques : affichées aussi sur le menu QR, où le client n'est pas connecté. */
  @Get(':name')
  @Public()
  serve(@Param('name') name: string, @Res() res: Response): void {
    const path = this.media.resolve(name);
    if (!path || !existsSync(path)) throw notFound('Image');
    // Le nom du fichier change à chaque nouvelle photo : le cache peut être permanent.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.type('image/webp').sendFile(path);
  }
}
