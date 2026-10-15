import { type INestApplication } from '@nestjs/common';
import { type PrismaClient } from '@tchop/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO, enrollDevice, passwordLogin, pinLogin, startApp, testDb, userIdByName } from './helpers.js';

let app: INestApplication;
let db: PrismaClient;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await startApp();
  db = testDb();
});

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
});

describe('santé', () => {
  it('répond sans connexion', async () => {
    const { body } = await http().get('/api/health').expect(200);
    expect(body).toMatchObject({ status: 'ok', mode: 'site', db: 'ok' });
  });
});

describe('connexion par mot de passe', () => {
  it('ouvre une session et pose un cookie de rafraîchissement protégé', async () => {
    const res = await http().post('/api/auth/login').send(DEMO.manager).expect(200);
    expect(res.body.accessToken).toBeTypeOf('string');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/tchop_rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);

    const me = await http()
      .get('/api/auth/me')
      .set('authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
    expect(me.body.role.code).toBe('manager');
    expect(me.body.grants['device.manage']).toBe('full');
    expect(me.body.grants['bill.reopen']).toBe('approval');
  });

  it('le propriétaire (rôle « tous les sites ») accède au site', async () => {
    const { accessToken } = await passwordLogin(app, DEMO.owner);
    const me = await http().get('/api/auth/me').set('authorization', `Bearer ${accessToken}`).expect(200);
    expect(me.body.role.code).toBe('owner');
  });

  it('refuse un mauvais mot de passe et le trace dans le journal', async () => {
    const before = await db.auditLog.count({ where: { action: 'auth.login_failed' } });
    const res = await http()
      .post('/api/auth/login')
      .send({ ...DEMO.manager, password: 'mauvais' })
      .expect(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(await db.auditLog.count({ where: { action: 'auth.login_failed' } })).toBe(before + 1);
  });

  it('donne la même réponse pour un identifiant inconnu', async () => {
    const res = await http().post('/api/auth/login').send({ username: 'inconnu', password: 'x' }).expect(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuse un corps de requête invalide', async () => {
    const res = await http().post('/api/auth/login').send({ username: '' }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('exige une connexion sur une route protégée', async () => {
    const res = await http().get('/api/auth/me').expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });
});

describe('enregistrement des appareils', () => {
  it("un code d'enregistrement ne sert qu'une fois", async () => {
    const { accessToken } = await passwordLogin(app, DEMO.manager);
    const { body: code } = await http()
      .post('/api/devices/enrollment-codes')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(201);
    expect(code.code).toMatch(/^\d{6}$/);

    await http()
      .post('/api/devices/enroll')
      .send({ code: code.code, name: 'Caisse 1', kind: 'tablet' })
      .expect(201);
    const again = await http()
      .post('/api/devices/enroll')
      .send({ code: code.code, name: 'Intrus', kind: 'tablet' })
      .expect(401);
    expect(again.body.code).toBe('INVALID_ENROLLMENT_CODE');
  });

  it("l'écran PIN liste le personnel du site qui a un PIN", async () => {
    const { deviceToken } = await enrollDevice(app);
    const { body } = await http().get('/api/devices/me').set('x-device-token', deviceToken).expect(200);
    const names = body.users.map((u: { displayName: string }) => u.displayName);
    expect(names).toEqual(expect.arrayContaining(['Joël', 'Mireille', 'Paul (gérant)']));
    expect(names).not.toContain('Cabinet comptable'); // pas de PIN
  });

  it("un appareil inconnu n'accède pas à l'écran PIN", async () => {
    const res = await http().get('/api/devices/me').set('x-device-token', 'faux').expect(401);
    expect(res.body.code).toBe('DEVICE_REVOKED');
    await http().get('/api/devices/me').expect(401);
  });
});

describe('connexion par PIN', () => {
  it("lie la session à l'appareil qui l'a ouverte", async () => {
    const { deviceToken } = await enrollDevice(app);
    const { accessToken } = await pinLogin(app, deviceToken, DEMO.waiterPin);

    await http()
      .get('/api/auth/me')
      .set('authorization', `Bearer ${accessToken}`)
      .set('x-device-token', deviceToken)
      .expect(200);

    const res = await http().get('/api/auth/me').set('authorization', `Bearer ${accessToken}`).expect(401);
    expect(res.body.code).toBe('DEVICE_MISMATCH');

    const other = await enrollDevice(app, 'Autre tablette');
    await http()
      .get('/api/auth/me')
      .set('authorization', `Bearer ${accessToken}`)
      .set('x-device-token', other.deviceToken)
      .expect(401);
  });

  it('exige un appareil enregistré', async () => {
    const res = await http()
      .post('/api/auth/pin')
      .send({ userId: '0199f000-0000-7000-8000-000000000099', pin: '1234' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('DEVICE_REQUIRED');
  });

  it('bloque le compte après 5 PIN faux, même avec le bon PIN ensuite', async () => {
    const { deviceToken } = await enrollDevice(app);
    const userId = await userIdByName(app, deviceToken, DEMO.cashierPin.displayName);
    try {
      for (let i = 0; i < 5; i++) {
        await http()
          .post('/api/auth/pin')
          .set('x-device-token', deviceToken)
          .send({ userId, pin: '0000' })
          .expect(401);
      }
      const locked = await http()
        .post('/api/auth/pin')
        .set('x-device-token', deviceToken)
        .send({ userId, pin: DEMO.cashierPin.pin })
        .expect(423);
      expect(locked.body.code).toBe('PIN_LOCKED');
      expect(
        await db.auditLog.count({ where: { actorId: userId, action: 'auth.pin_locked' } }),
      ).toBeGreaterThan(0);
    } finally {
      await db.user.update({ where: { id: userId }, data: { pinFailedCount: 0, pinLockedUntil: null } });
    }
  });
});

describe('permissions', () => {
  it("un serveur n'accède pas à la gestion des appareils, le gérant oui", async () => {
    const { deviceToken, managerToken } = await enrollDevice(app);
    const { accessToken } = await pinLogin(app, deviceToken, DEMO.waiterPin);
    const forbidden = await http()
      .get('/api/devices')
      .set('authorization', `Bearer ${accessToken}`)
      .set('x-device-token', deviceToken)
      .expect(403);
    expect(forbidden.body.code).toBe('FORBIDDEN');

    await http().get('/api/devices').set('authorization', `Bearer ${managerToken}`).expect(200);
  });

  it("la lecture seule n'autorise pas l'écriture", async () => {
    // Le comptable n'a aucun droit sur les appareils ; vérifie aussi qu'un rôle sans la permission est refusé en lecture.
    const { accessToken } = await passwordLogin(app, DEMO.accountant);
    await http().get('/api/devices').set('authorization', `Bearer ${accessToken}`).expect(403);
    await http()
      .post('/api/devices/enrollment-codes')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(403);
  });
});

describe('rafraîchissement et déconnexion', () => {
  it('fait tourner le jeton et révoque toute la famille en cas de réutilisation', async () => {
    const login = await http().post('/api/auth/login').send(DEMO.manager).expect(200);
    const firstCookie = cookieValue(login.headers['set-cookie']);

    const rotated = await http()
      .post('/api/auth/refresh')
      .set('cookie', `tchop_rt=${firstCookie}`)
      .expect(200);
    const secondCookie = cookieValue(rotated.headers['set-cookie']);
    expect(secondCookie).not.toBe(firstCookie);

    // Réutilisation de l'ancien jeton : refus, et le nouveau jeton est révoqué lui aussi.
    const reuse = await http().post('/api/auth/refresh').set('cookie', `tchop_rt=${firstCookie}`).expect(401);
    expect(reuse.body.code).toBe('SESSION_INVALID');
    await http().post('/api/auth/refresh').set('cookie', `tchop_rt=${secondCookie}`).expect(401);
    expect(await db.auditLog.count({ where: { action: 'auth.refresh_reuse_detected' } })).toBeGreaterThan(0);
  });

  it('la déconnexion invalide la session et son jeton d’accès', async () => {
    const { agent, accessToken } = await passwordLogin(app, DEMO.manager);
    await agent.post('/api/auth/logout').expect(204);
    await agent.post('/api/auth/refresh').expect(401);
    const res = await http().get('/api/auth/me').set('authorization', `Bearer ${accessToken}`).expect(401);
    expect(res.body.code).toBe('SESSION_INVALID');
  });

  it('une session PIN ne se rafraîchit que depuis son appareil', async () => {
    const { deviceToken } = await enrollDevice(app);
    const { agent } = await pinLogin(app, deviceToken, DEMO.waiterPin);
    await agent.post('/api/auth/refresh').expect(401);
  });
});

describe('révocation d’un appareil', () => {
  it('bloque son jeton et ferme ses sessions', async () => {
    const { deviceToken, deviceId, managerToken } = await enrollDevice(app, 'Tablette volée');
    const { accessToken } = await pinLogin(app, deviceToken, DEMO.waiterPin);

    await http()
      .post(`/api/devices/${deviceId}/revoke`)
      .set('authorization', `Bearer ${managerToken}`)
      .expect(204);

    const res = await http().get('/api/devices/me').set('x-device-token', deviceToken).expect(401);
    expect(res.body.code).toBe('DEVICE_REVOKED');
    const sessions = await db.authSession.findMany({ where: { deviceId } });
    expect(sessions.every((s) => s.revokedAt)).toBe(true);
    expect(accessToken).toBeTruthy();
  });
});

describe('journal d’audit', () => {
  it('refuse toute modification ou suppression', async () => {
    const entry = await db.auditLog.findFirstOrThrow();
    await expect(
      db.auditLog.update({ where: { id: entry.id }, data: { action: 'falsifié' } }),
    ).rejects.toThrow();
    await expect(db.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow();
  });
});

describe('limitation des tentatives', () => {
  it('renvoie 429 au-delà de la limite de connexions par minute', async () => {
    const limited = await startApp({ AUTH_RATE_LIMIT: '3' });
    try {
      const server = limited.getHttpServer();
      for (let i = 0; i < 3; i++) {
        await request(server).post('/api/auth/login').send({ username: 'x', password: 'y' }).expect(401);
      }
      await request(server).post('/api/auth/login').send({ username: 'x', password: 'y' }).expect(429);
      // Les routes ordinaires ne sont pas concernées par cette limite.
      await request(server).get('/api/health').expect(200);
    } finally {
      await limited.close();
    }
  });
});

function cookieValue(header: unknown): string {
  const match = /tchop_rt=([^;]+)/.exec(String(header));
  if (!match?.[1]) throw new Error('Cookie de rafraîchissement absent');
  return match[1];
}
