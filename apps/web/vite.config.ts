import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const apiTarget = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'TCHOP LIFE',
        short_name: 'TCHOP LIFE',
        description: 'Gestion de snack-bar, lounge, bar et grill',
        lang: 'fr',
        start_url: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#1f1a16',
        background_color: '#f5f2ee',
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
