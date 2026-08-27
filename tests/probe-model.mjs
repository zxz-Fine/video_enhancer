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
  const resp = await fetch('/models/imdn-x2.onnx');
  const buf = new Uint8Array(await resp.arrayBuffer());
  const session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
  const S = 32;
  const px = S * S;
  function run(inputArr, dims) {
    return session.run({ input: new ort.Tensor('float32', inputArr, dims) });
  }
  function greyValue(order, scale) {
    // order: array mapping output-channel-slot -> source channel; grey identical anyway
    const a = new Float32Array(3 * px).fill(0.5 * scale);
    return a;
  }
  function colorSolid(R, G, B, order, scale) {
    // order = [slotForR, slotForG, slotForB] meaning: model channel0 = R if order[0]=0 etc.
    // We build model input where model-channel c receives color component comp[c]
    const comp = { r: R, g: G, b: B };
    const mapR = order[0], mapG = order[1], mapB = order[2];
    const a = new Float32Array(3 * px);
    const v0 = [R, G, B][mapR] * scale;
    const v1 = [R, G, B][mapG] * scale;
    const v2 = [R, G, B][mapB] * scale;
    a.fill(0);
    // NCHW fill
    for (let i = 0; i < px; i++) { a[i] = v0; a[px + i] = v1; a[2 * px + i] = v2; }
    return a;
  }
  const results = {};
  {
    const a = new Float32Array(3 * px).fill(0);
    for (let i = 0; i < px; i++) a[i] = 255;
    const out = await run(a, [1, 3, S, S]);
    const t = out[session.outputNames[0]];
    const c = 16 * t.dims[3] + 16;
    const stride = t.dims[2] * t.dims[3];
    results['red255_raw'] = [0, 1, 2].map((ch) => t.data[stride * ch + c].toFixed(2)).join(',');
    const g = new Float32Array(3 * px).fill(128);
    const o2 = await run(g, [1, 3, S, S]);
    const t2 = o2[session.outputNames[0]];
    results['grey128_raw'] = [0, 1, 2].map((ch) => t2.data[stride * ch + c].toFixed(2)).join(',');
  }
  // B) red input under RGB and BGR channel order, scale 1 and 255
  for (const orderName of ['RGB', 'BGR']) {
    for (const scale of [1, 255]) {
      const order = orderName === 'RGB' ? [0, 1, 2] : [2, 1, 0];
      const out = await run(colorSolid(1, 0, 0, order, scale), [1, 3, S, S]);
      const t = out[session.outputNames[0]];
      const c = 16 * t.dims[3] + 16;
      // read output assuming same order back to RGB
      const vals = [0, 1, 2].map((ch) => t.data[t.dims[2] * t.dims[3] * ch + c] / scale);
      const rgb = orderName === 'RGB' ? vals : [vals[2], vals[1], vals[0]];
      results[`red/${orderName}/s${scale}`] = rgb.map((v) => Math.round(v * 255)).join(',');
    }
  }
  return results;
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
await server.close();
