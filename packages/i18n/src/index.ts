import { en } from './en.js';
import { fr, type MessageKey, type Messages } from './fr.js';

export type { MessageKey, Messages };
export type Locale = 'fr' | 'en';

export const catalogs: Record<Locale, Messages> = { fr, en };

/** Traduit une clé et remplace les paramètres {nom}. */
export function translate(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  const text = catalogs[locale][key] ?? catalogs.fr[key];
  return params ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`)) : text;
}
