// RIFE 尺寸兼容性探针：验证不同输入尺寸在 wasm EP 下是否正常
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
  const out = {};
  for (const [W, H] of [[256, 256], [320, 256], [320, 240], [64, 64]]) {
    const px = W * H;
    const frame = () => {
      const d = new Float32Array(3 * px);
      for (let i = 0; i < px; i++) {
        d[i] = (i % W) / W;
        d[px + i] = 0.5;
        d[2 * px + i] = 0.25;
      }
      return d;
    };
    const grid = new Float32Array(2 * px);
    for (let y = 0; y < H; y++) {
      const yn = (y / (H - 1)) * 2 - 1;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        grid[i] = (x / (W - 1)) * 2 - 1;
        grid[px + i] = yn;
      }
    }
    try {
      const res = await session.run({
        img0: new ort.Tensor('float32', frame(), [1, 3, H, W]),
        img1: new ort.Tensor('float32', frame(), [1, 3, H, W]),
        timestep: new ort.Tensor('float32', new Float32Array([0.5]), [1, 1, 1, 1]),
        tenFlow_div: new ort.Tensor('float32', new Float32Array([W, H]), [2]),
        backwarp_tenGrid: new ort.Tensor('float32', grid, [1, 2, H, W]),
      });
      const t = res['frame'];
      let finite = true;
      for (let i = 0; i < t.data.length; i += 997) if (!Number.isFinite(t.data[i])) { finite = false; break; }
      out[`${W}x${H}`] = `ok dims=${t.dims.join(',')} finite=${finite} mid=${t.data[Math.floor(t.data.length / 2)].toFixed(3)}`;
    } catch (e) {
      out[`${W}x${H}`] = 'ERR: ' + e.message.slice(0, 100);
    }
  }
  return out;
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
await server.close();
