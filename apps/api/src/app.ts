import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { type AppConfig } from './config.js';

/** Crée l'application (utilisé par main.ts et par les tests). */
export async function createApp(
  config: AppConfig,
  options: { logger?: false } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    ...(options.logger === false ? { logger: false } : {}),
  });
  app.set('trust proxy', config.TRUST_PROXY);
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());
  const origins = config.WEB_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length) app.enableCors({ origin: origins, credentials: true });
  app.enableShutdownHooks();
  return app;
}
