/**
 * Politique de sécurité du contenu (CSP) des pages servies aux navigateurs.
 * Tout vient de l'établissement : aucun script, style ou police externe, pas d'intégration dans un autre site.
 * `frame-ancestors` ne s'applique que par en-tête HTTP (serveur web) ; la balise meta couvre le reste.
 */
export function contentSecurityPolicy(options: { websocket?: boolean } = {}): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Styles inline : attributs style de React (aucun script inline n'est autorisé).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${options.websocket ? ' ws: wss:' : ''}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}
