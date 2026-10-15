import react from '@vitejs/plugin-react';
import { contentSecurityPolicy } from '@tchop/shared';
import { defineConfig, type Plugin } from 'vite';

const apiTarget = process.env.API_URL ?? 'http://localhost:3000';

/** CSP ajoutée à la page compilée (en développement, Vite a besoin de scripts inline). */
const csp = (): Plugin => ({
  name: 'tchop-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}" />`,
    ),
});

// Menu public ouvert par le QR code (/q/{jeton}). Servi par le serveur local ; par le cloud en Phase 3b.
export default defineConfig({
  plugins: [react(), csp()],
  server: {
    port: 5181,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  preview: {
    port: 5181,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
});
