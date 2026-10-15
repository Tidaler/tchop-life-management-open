import { describe, expect, it } from 'vitest';
import { catalogs, translate } from './index.js';

describe('traductions', () => {
  it('chaque texte anglais garde les mêmes paramètres que le français', () => {
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, text] of Object.entries(catalogs.fr)) {
      expect(params(catalogs.en[key as keyof typeof catalogs.en]), key).toEqual(params(text));
    }
  });

  it('remplace les paramètres', () => {
    expect(translate('fr', 'home.hello', { name: 'Joël' })).toBe('Bonjour Joël');
    expect(translate('en', 'pin.locked', { minutes: 5 })).toBe('Too many attempts. Try again in 5 min.');
  });
});
