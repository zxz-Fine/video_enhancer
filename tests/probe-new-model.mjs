// 通用新模型探针：灰色恒等（输入范围 0-1 / 0-255 二选一）+ RGB 通道序 + 奇数尺寸行为
// 用法：node tests/probe-new-model.mjs /models/realesr-animevideov3.onnx [wasm|webgpu]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const modelFile = process.argv[2] ?? '/models/imdn-x2.onnx';
const epArg = process.argv[3] ?? 'wasm';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.goto('http://localhost:5199/');
await page.waitForTimeout(800);
const r = await page.evaluate(
  async ({ modelFile, epArg }) => {
    const ort = epArg === 'webgpu'
      ? await import('/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs').catch(() => import('/node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs'))
      : await import('/node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs');
    const resp = await fetch(modelFile);
    const buf = new Uint8Array(await resp.arrayBuffer());
    const session = await ort.InferenceSession.create(buf, { executionProviders: [epArg] });
    const inName = session.inputNames[0];
    const outName = session.outputNames[0];
    const out = {};
    out.inputName = inName;
    out.outputName = outName;
    async function grey(S, fill, range) {
      const px = S * S;
      const a = new Float32Array(3 * px).fill(fill);
      const t = (await session.run({ [inName]: new ort.Tensor('float32', a, [1, 3, S, S]) }))[outName];
      const d = t.data;
      const ow = t.dims[3];
      const oh = t.dims[2];
      const stride = ow * oh;
      let finite = true;
      let mean = 0;
      let spreadMax = 0;
      let n = 0;
      for (let y = 8; y < oh - 8; y += 8) {
        for (let x = 8; x < ow - 8; x += 8) {
          const i = y * ow + x;
          const r = d[i];
          const g = d[stride + i];
          const b = d[stride * 2 + i];
          if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) finite = false;
          const m = (r + g + b) / 3;
          mean += m;
          spreadMax = Math.max(spreadMax, Math.abs(r - m), Math.abs(g - m), Math.abs(b - m));
          n++;
        }
      }
      return { dims: t.dims.join('x'), mean: +(mean / n).toFixed(3), spreadMax: +spreadMax.toFixed(3), finite, expectMean: fill };
    }
    out.grey_s1 = await grey(32, 0.5, 1);
    out.grey_s255 = await grey(32, 127.5, 255);
    // 奇数尺寸：确认输出 dims 与是否抛错
    try {
      const W = 31;
      const H = 33;
      const px = W * H;
      const a = new Float32Array(3 * px).fill(0.5);
      const t = (await session.run({ [inName]: new ort.Tensor('float32', a, [1, 3, H, W]) }))[outName];
      out.odd = { in: `${W}x${H}`, dims: t.dims.join('x') };
    } catch (e) {
      out.odd = { error: String(e).slice(0, 160) };
    }
    // 纯红输入：判断通道是否 RGB（range=1 下红色通道输出应≈1，其余≈0）
    {
      const S = 32;
      const px = S * S;
      const a = new Float32Array(3 * px);
      for (let i = 0; i < px; i++) a[i] = 1;
      const t = (await session.run({ [inName]: new ort.Tensor('float32', a, [1, 3, S, S]) }))[outName];
      const c = 16 * t.dims[3] + 16;
      const stride = t.dims[2] * t.dims[3];
      out.red_s1 = [t.data[c], t.data[stride + c], t.data[stride * 2 + c]].map((v) => +v.toFixed(3)).join(',');
    }
    return out;
  },
  { modelFile, epArg },
);
console.log(JSON.stringify(r, null, 2));
await browser.close();
await server.close();
