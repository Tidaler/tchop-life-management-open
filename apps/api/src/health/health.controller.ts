import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { PrismaService } from '../prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** État du serveur : utilisé par la supervision et par les tablettes pour détecter une coupure. */
  @Get()
  @Public()
  async health() {
    const db = await this.prisma.$queryRaw`SELECT 1`.then(
      () => 'ok' as const,
      () => 'error' as const,
    );
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      mode: this.config.API_MODE,
      db,
      time: new Date().toISOString(),
    };
  }
}
