import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
  plugins: [tailwindcss(), reactRouter()],
  server: {
    host: '127.0.0.1',
  },
});
