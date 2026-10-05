import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], base: './', envPrefix: '__MOMO_NO_RENDERER_ENV__', server: { host: '127.0.0.1', port: 5173, strictPort: true }, build: { sourcemap: false } });
