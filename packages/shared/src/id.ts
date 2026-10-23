/**
 * Identifiant unique (UUID v4) pour les clés d'envoi et les lignes en cours de saisie.
 * crypto.randomUUID n'existe pas sur les navigateurs anciens (Chrome avant 92, iOS avant 15.4) ni sur
 * une page dont le certificat n'est pas reconnu : on le reconstruit alors avec crypto.getRandomValues,
 * disponible partout.
 */
export function newId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variante RFC 4122
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
