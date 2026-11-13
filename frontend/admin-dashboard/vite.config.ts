import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const DEFAULT_API_ORIGIN =
  'https://h5ekgxy0j7.execute-api.ap-southeast-1.amazonaws.com';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const target = env.API_PROXY_TARGET || DEFAULT_API_ORIGIN;
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, '/v1'),
        }
      }
    }
  }
});
