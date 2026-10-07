import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Allow ngrok tunnels so the dev server can be opened inside LINE.
    allowedHosts: ['.ngrok-free.dev'],
  },
});
