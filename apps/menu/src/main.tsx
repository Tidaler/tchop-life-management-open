import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Squelette du menu public. Le parcours complet (menu, panier, suivi de commande) arrive en Phase 3 ;
 * voir docs/maquettes (onglet « Menu QR ») et docs/architecture/03-synchronisation.md.
 */
function MenuApp() {
  const token = window.location.pathname.match(/^\/q\/([\w-]+)$/)?.[1];
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 480, margin: '0 auto' }}>
      <h1>TCHOP LIFE</h1>
      <p>
        {token ? 'Le menu de cette table sera bientôt disponible.' : 'Scannez le QR code de votre table.'}
      </p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MenuApp />
  </StrictMode>,
);
