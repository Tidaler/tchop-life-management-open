import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@tchop/db';
import request from 'supertest';
// Les tests utilisent l'API compilée : Nest a besoin des métadonnées de décorateurs émises par tsc.
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';

// Identifiants du seed de démo (packages/db/prisma/seed.ts).
export const DEMO_SITE_ID = '0199f000-0000-7000-8000-000000000001';
export const DEMO = {
  manager: { username: 'gerant', password: 'Demo-Gerant-2026!', pin: '4826' },
  owner: { username: 'proprietaire', password: 'Demo-Proprio-2026!' },
  accountant: { username: 'comptable', password: 'Demo-Compta-2026!' },
  waiterPin: { displayName: 'Joël', pin: '1357' },
  cashierPin: { displayName: 'Mireille', pin: '2468' },
  kitchenPin: { displayName: 'Poste cuisine', pin: '9753' },
};

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    API_MODE: 'site',
    SITE_ID: DEMO_SITE_ID,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    JWT_SECRET: 'test-secret-0123456789abcdef0123456789',
    COOKIE_SECURE: 'false',
    AUTH_RATE_LIMIT: '1000',
    WEB_ORIGIN: '',
    MEDIA_DIR: join(tmpdir(), 'tchop-test-media'),
    PUBLIC_MENU_URL: 'https://menu.test.local',
    ...overrides,
  });
}

export async function startApp(overrides: Record<string, string> = {}): Promise<INestApplication> {
  const app = await createApp(testConfig(overrides), { logger: false });
  await app.init();
  return app;
}

export const testDb = (): PrismaClient => createPrismaClient(process.env.TEST_DATABASE_URL!);

export async function passwordLogin(app: INestApplication, creds: { username: string; password: string }) {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/api/auth/login').send(creds).expect(200);
  return { agent, accessToken: res.body.accessToken as string };
}

/** Enregistre un nouvel appareil (via un code créé par le gérant) et renvoie son jeton. */
export async function enrollDevice(app: INestApplication, name = 'Tablette de test') {
  const { accessToken } = await passwordLogin(app, DEMO.manager);
  const { body: code } = await request(app.getHttpServer())
    .post('/api/devices/enrollment-codes')
    .set('authorization', `Bearer ${accessToken}`)
    .expect(201);
  const { body } = await request(app.getHttpServer())
    .post('/api/devices/enroll')
    .send({ code: code.code, name, kind: 'tablet' })
    .expect(201);
  return {
    deviceToken: body.deviceToken as string,
    deviceId: body.device.id as string,
    managerToken: accessToken,
  };
}

export async function userIdByName(app: INestApplication, deviceToken: string, displayName: string) {
  const { body } = await request(app.getHttpServer())
    .get('/api/devices/me')
    .set('x-device-token', deviceToken)
    .expect(200);
  const user = (body.users as { id: string; displayName: string }[]).find(
    (u) => u.displayName === displayName,
  );
  if (!user) throw new Error(`Utilisateur ${displayName} absent de l'écran PIN`);
  return user.id;
}

export async function pinLogin(
  app: INestApplication,
  deviceToken: string,
  user: { displayName: string; pin: string },
) {
  const agent = request.agent(app.getHttpServer());
  const userId = await userIdByName(app, deviceToken, user.displayName);
  const res = await agent
    .post('/api/auth/pin')
    .set('x-device-token', deviceToken)
    .send({ userId, pin: user.pin })
    .expect(200);
  return { agent, userId, accessToken: res.body.accessToken as string };
}
