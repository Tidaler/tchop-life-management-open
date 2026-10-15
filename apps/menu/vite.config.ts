import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Menu public ouvert par le QR code : page légère, servie par le cloud (Phase 3).
export default defineConfig({
  plugins: [react()],
  server: { port: 5181, strictPort: true },
});
