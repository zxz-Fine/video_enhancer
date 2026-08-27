import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import fs from 'node:fs';

const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.goto('http://localhost:5199/');
await page.waitForTimeout(1000);

const files = {
  'out-1x': Array.from(fs.readFileSync('/tmp/opencode/out-1x.mp4')),
  'out-2x': Array.from(fs.readFileSync('/tmp/opencode/out-2x.mp4')),
};

const out = await page.evaluate(async (files) => {
  const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');

  async function analyze(bytes) {
    const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(new Blob([new Uint8Array(bytes)])) });
    const vt = await input.getPrimaryVideoTrack();
    const sink = new mb.CanvasSink(vt, { poolSize: 1 });
    let first = null;
    let n = 0;
    for await (const { canvas, timestamp } of sink.canvases()) {
      const ctx = canvas.getContext('2d');
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let min = 255;
      let max = 0;
      let sum = 0;
      let cnt = 0;
      for (let i = 0; i < img.data.length; i += 4 * 31) {
        const l = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
        if (l < min) min = l;
        if (l > max) max = l;
        sum += l;
        cnt++;
      }
      if (!first) first = { ts: timestamp, lumaMin: Math.round(min), lumaMax: Math.round(max), lumaMean: (sum / cnt).toFixed(1) };
      n++;
    }
    return { frames: n, first };
  }

  const results = {};
  for (const [name, bytes] of Object.entries(files)) {
    results[name] = await analyze(bytes);
  }
  return results;
}, files);

console.log(JSON.stringify(out, null, 2));

const ok1 = out['out-1x'].first.lumaMax > 100 && out['out-1x'].first.lumaMin < 200;
const ok2 = out['out-2x'].first.lumaMax > 100;
console.log(ok1 && ok2 ? 'CONTENT CHECK PASS' : 'CONTENT CHECK FAIL');
await browser.close();
await server.close();
process.exit(ok1 && ok2 ? 0 : 1);
