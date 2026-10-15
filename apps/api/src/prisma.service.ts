import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, PrismaPg } from '@tchop/db';
import { APP_CONFIG, type AppConfig } from './config.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
