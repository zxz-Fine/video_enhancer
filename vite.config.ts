import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'node:fs';
import path from 'node:path';

function ortAssets(): Plugin {
  const root = path.resolve(import.meta.dirname ?? '.', 'node_modules/onnxruntime-web/dist');
  const MIME: Record<string, string> = {
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
    '.wasm': 'application/wasm',
  };
  const handler = (req: import('http').IncomingMessage, res: import('http').ServerResponse, next: () => void) => {
    console.log('[ort-mw]', req.url);
    const file = decodeURIComponent((req.url ?? '').split('?')[0]);
    const fp = path.join(root, file);
    if (!fp.startsWith(root) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) return next();
    res.setHeader('Content-Type', MIME[path.extname(fp)] ?? 'application/octet-stream');
    fs.createReadStream(fp).pipe(res);
  };
  return {
    name: 'ort-assets',
    configureServer(server) {
      server.middlewares.use('/ort', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/ort', handler);
    },
  };
}

export default defineConfig({
  plugins: [basicSsl(), ortAssets()],
  server: {
    host: true,
  },
});
