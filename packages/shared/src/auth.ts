import { z } from 'zod';
import { DEVICE_KINDS } from './constants.js';

/** Connexion par identifiant et mot de passe (back-office, accès à distance). */
export const passwordLoginSchema = z.object({
  /** Obligatoire en mode cloud ; ignoré sur un serveur local, qui ne sert qu'un client. */
  tenant: z.string().trim().min(1).optional(),
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(256),
  siteId: z.uuid().optional(),
});
export type PasswordLoginInput = z.infer<typeof passwordLoginSchema>;

/** Connexion rapide par PIN sur un appareil enregistré. */
export const pinLoginSchema = z.object({
  userId: z.uuid(),
  pin: z.string().regex(/^\d{4,6}$/, 'Le PIN doit contenir 4 à 6 chiffres'),
});
export type PinLoginInput = z.infer<typeof pinLoginSchema>;

export const enrollDeviceSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Le code doit contenir 6 chiffres'),
  name: z.string().trim().min(1).max(60),
  kind: z.enum(DEVICE_KINDS),
});
export type EnrollDeviceInput = z.infer<typeof enrollDeviceSchema>;

export const PASSWORD_MIN_LENGTH = 12;
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(256);
