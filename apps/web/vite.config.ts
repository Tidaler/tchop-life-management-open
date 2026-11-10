import react from '@vitejs/plugin-react';
import { contentSecurityPolicy } from '@tchop/shared';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const apiTarget = process.env.API_URL ?? 'http://127.0.0.1:3000';

/** CSP ajoutée à la page compilée (en développement, Vite a besoin de scripts inline). */
const csp = (): Plugin => ({
  name: 'tchop-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy({ websocket: true })}" />`,
    ),
});

export default defineConfig({
  plugins: [
    react(),
    csp(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'TidalEx Resto',
        short_name: 'TidalEx',
        description: 'Gestion de snack-bar, lounge, bar et grill',
        lang: 'fr',
        start_url: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#1a0042',
        background_color: '#f6f4f8',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // L'API n'est jamais mise en cache : les données viennent toujours du serveur local.
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
      },
    }),
  ],
  server: {
    port: 5180,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false, ws: true } },
  },
  preview: {
    port: 5180,
    proxy: { '/api': { target: apiTarget, changeOrigin: false, ws: true } },
  },
});
