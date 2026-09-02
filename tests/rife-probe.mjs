import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://localhost:5199/');
await page.waitForTimeout(800);
const r = await page.evaluate(async () => {
  const ort = await import('/node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs');
  const resp = await fetch('/models/rife422-lite.onnx');
  const session = await ort.InferenceSession.create(new Uint8Array(await resp.arrayBuffer()), { executionProviders: ['wasm'] });
  const S = 256;
  const px = S * S;

  function frame(shift) {
    const d = new Float32Array(3 * px);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const sx = (x + shift + S) % S;
        const i = y * S + x;
        d[i] = sx / S;
        d[px + i] = 0.5 + 0.5 * Math.sin(y / 20);
        d[2 * px + i] = (S - sx) / S;
      }
    }
    return d;
  }
  const img0 = frame(0);
  const img1 = frame(40);

  function mad(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  const combos = [];
  for (const gridOrder of ['xy', 'yx']) {
    for (const divOrder of ['wh', 'hw']) {
      combos.push([gridOrder, divOrder]);
    }
  }
  const results = {};
  for (const [gridOrder, divOrder] of combos) {
    const grid = new Float32Array(2 * px);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const xn = (x / (S - 1)) * 2 - 1;
        const yn = (y / (S - 1)) * 2 - 1;
        if (gridOrder === 'xy') { grid[i] = xn; grid[px + i] = yn; }
        else { grid[i] = yn; grid[px + i] = xn; }
      }
    }
    const div = divOrder === 'wh' ? [S, S] : [S, S];
    const tryRun = async (t) => {
      const out = await session.run({
        img0: new ort.Tensor('float32', img0, [1, 3, S, S]),
        img1: new ort.Tensor('float32', img1, [1, 3, S, S]),
        timestep: new ort.Tensor('float32', new Float32Array([t]), [1, 1, 1, 1]),
        tenFlow_div: new ort.Tensor('float32', new Float32Array(div), [2]),
        backwarp_tenGrid: new ort.Tensor('float32', grid, [1, 2, S, S]),
      });
      return out['frame'].data;
    };
    try {
      const d0 = mad(await tryRun(0), img0);
      const d1 = mad(await tryRun(1), img1);
      results[`${gridOrder}/${divOrder}`] = { d0: d0.toFixed(4), d1: d1.toFixed(4) };
    } catch (e) {
      results[`${gridOrder}/${divOrder}`] = 'ERR: ' + e.message.slice(0, 80);
    }
  }
  return results;
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
await server.close();
