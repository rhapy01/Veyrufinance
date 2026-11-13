import path from 'path';
import { readdirSync, realpathSync } from 'fs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, transformWithEsbuild } from 'vite';

const port = Number(process.env.PORT) || 5173;
const basePath = process.env.BASE_PATH || '/';
const pnpmStore = path.resolve(import.meta.dirname, '../../node_modules/.pnpm');
const bufferStoreEntry = readdirSync(pnpmStore).find((entry) => entry.startsWith('buffer@'));
if (!bufferStoreEntry) throw new Error('The browser buffer polyfill is missing from the pnpm store.');

export default defineConfig({
  // Load the workspace-level .env.local used by the API as well.
  envDir: path.resolve(import.meta.dirname, '../..'),
  base: basePath,
  // Browser shims inside near-api-js/util expect Node's `process` global.
  // The app shell installs a tiny browser-safe shim before any modules load.
  define: {
    global: 'globalThis',
    process: 'globalThis.process',
  },
  plugins: [
    {
      name: 'fast-auth-jsx-in-js',
      enforce: 'pre',
      async transform(code, id) {
        if (!id.includes('/@fast-auth-near/react-sdk/dist/') || !id.endsWith('.js')) return null;
        return transformWithEsbuild(code, id, { loader: 'jsx', jsx: 'transform' });
      },
    },
    react(),
    tailwindcss({ optimize: false }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
      // Resolve through the workspace package link so the pnpm store's peer
      // dependency suffix can change without breaking Vite.
      'viem/utils': path.join(realpathSync(path.resolve(import.meta.dirname, 'node_modules/viem')), '_esm/utils/index.js'),
      viem: realpathSync(path.resolve(import.meta.dirname, 'node_modules/viem')),
      // NEAR's base-x dependency imports Node's `buffer` builtin. Use the
      // browser polyfill already present in the pnpm dependency graph.
      buffer: path.resolve(pnpmStore, bufferStoreEntry, 'node_modules/buffer/index.js'),
      '@privy-io/are-addresses-equal': path.resolve(import.meta.dirname, 'src/lib/privy-address-equality.ts'),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  optimizeDeps: {
    // @fast-auth-near/react-sdk ships JSX in .js files; tell esbuild how to
    // parse that package during Vite's dependency pre-bundle.
    esbuildOptions: {
      loader: { '.js': 'jsx' },
      define: { process: 'globalThis.process' },
    },
    // Privy's Stripe on-ramp peer is optional and isn't used by this app.
    exclude: ['@stripe/crypto'],
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
