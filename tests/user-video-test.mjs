import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import fs from 'node:fs';

const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 150)));
await page.goto('http://localhost:5199/');
await page.waitForTimeout(1000);

const fileB64 = (() => {
  const buf = fs.readFileSync('test_video/vgt-exterior-black-hole-wheels.mp4');
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
})();
console.log('user video MB:', Math.round(fileB64.length * 3 / 4 / 1048576));

const results = await page.evaluate(
  async ({ b64 }) => {
    const { enhanceVideo } = await import('/src/enhance.ts');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'user.mp4', { type: 'video/mp4' });
    const out = {};
    for (const engine of ['imdn-x2']) {
      const sink = new (await import('/node_modules/mediabunny/dist/modules/src/index.js')).VideoSampleSink(
        await (async () => {
          const { Input, ALL_FORMATS, BlobSource } = await import('/node_modules/mediabunny/dist/modules/src/index.js');
          const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
          return input.getPrimaryVideoTrack();
        })(),
      );
      const t0 = performance.now();
      let count = 0;
      let firstMs = null;
      try {
        for await (const sample of sink.samples()) {
          const { FrameEnhancer } = await import('/src/gpu.ts');
          const { AiEngine } = await import('/src/ai.ts');
          if (!globalThis.__ai) globalThis.__ai = await AiEngine.load(engine, () => {});
          const { OffscreenCanvas: OC } = globalThis;
          const stage = new OC(sample.displayWidth, sample.displayHeight);
          const sctx = stage.getContext('2d');
          sample.draw(sctx, 0, 0, sample.displayWidth, sample.displayHeight);
          const f0 = performance.now();
          const canvas = await globalThis.__ai.processCanvas(stage);
          if (firstMs === null) firstMs = Math.round(performance.now() - f0);
          count++;
          sample.close();
          if (count >= 6) break;
        }
        out[engine] = { ok: true, frames: count, firstFrameMs: firstMs, totalSecs: ((performance.now() - t0) / 1000).toFixed(1) };
      } catch (e) {
        out[engine] = { ok: false, err: e.message.slice(0, 250) };
      }
    }
    return out;
  },
  { b64: fileB64 },
);
console.log(JSON.stringify(results, null, 2));
const allOk = Object.values(results).every((r) => r.ok);
console.log(allOk ? 'USER VIDEO TEST PASS' : 'USER VIDEO TEST FAIL');
await browser.close();
await server.close();
process.exit(allOk ? 0 : 1);
