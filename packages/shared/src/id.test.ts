import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { newId } from './id.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('identifiants', () => {
  it('donne un UUID v4 valide, même sans crypto.randomUUID (navigateur ancien)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    const ids = Array.from({ length: 200 }, () => newId());
    for (const id of ids) {
      expect(z.uuid().safeParse(id).success).toBe(true);
      expect(id[14]).toBe('4');
      expect('89ab').toContain(id[19]);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('utilise crypto.randomUUID quand il existe', () => {
    expect(z.uuid().safeParse(newId()).success).toBe(true);
  });
});
