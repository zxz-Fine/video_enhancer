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
  const models = [
    ['/models/imdn-x2.onnx', 64],
    ['/models/realesr-general-x4v3.onnx', 32],
    ['/models/realesr-animevideov3.onnx', 32],
    ['/models/realesrgan-anime6b-x4.onnx', 32],
    ['/models/realcugan-se-2x-denoise3.onnx', 32],
    ['/models/realcugan-se-2x-conservative.onnx', 32],
  ];
  const results = {};
  for (const [file, S] of models) {
    const resp = await fetch(file);
    const session = await ort.InferenceSession.create(new Uint8Array(await resp.arrayBuffer()), { executionProviders: ['wasm'] });
    const inName = session.inputNames[0];
    const px = S * S;
    const out = {};
    for (const scale of [1, 255]) {
      const grey = new Float32Array(3 * px).fill(0.5 * scale);
      const o = await session.run({ [inName]: new ort.Tensor('float32', grey, [1, 3, S, S]) });
      const t = o[session.outputNames[0]];
      const c = Math.floor(S / 2) * t.dims[3] + Math.floor(S / 2);
      const stride = t.dims[2] * t.dims[3];
      out[`grey_s${scale}`] = [0, 1, 2].map((ch) => (t.data[stride * ch + c] / scale).toFixed(3)).join(',');
    }
    results[file.split('/').pop()] = out;
    await session.release();
  }
  return results;
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
await server.close();
