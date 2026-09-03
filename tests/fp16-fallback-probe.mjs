// fp16→fp32 回退链探针：模拟 Intel 驱动 fp16 输出全零场景，验证 fp32 WebGPU 中间级可用且画质正确
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({
  executablePath: exe, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.goto('http://localhost:5199/');
await page.waitForTimeout(1000);
const r = await page.evaluate(async () => {
  const ort = await import('/node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs');
  // 与应用一致：jsep wasm 直接用 src/ort-assets 静态文件（vite 可直接服务）
  ort.env.wasm.wasmPaths = {
    mjs: '/src/ort-assets/ort-wasm-simd-threaded.jsep.mjs',
    wasm: '/src/ort-assets/ort-wasm-simd-threaded.jsep.wasm',
  };
  const out = {};
  const load = async (file, ep) => {
    const resp = await fetch(file);
    return ort.InferenceSession.create(new Uint8Array(await resp.arrayBuffer()), { executionProviders: [ep], graphOptimizationLevel: 'all' });
  };
  const grayRun = async (session) => {
    const S = 48;
    const chw = new Float32Array(3 * S * S).fill(0.5);
    const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', chw, [1, 3, S, S]) });
    const t = res[session.outputNames[0]];
    const i = 24 * t.dims[3] + 24;
    const stride = t.dims[2] * t.dims[3];
    return [t.data[i], t.data[stride + i], t.data[2 * stride + i]];
  };
  // fp16 在 swiftshader 上应通过（说明文件本身有效）
  try {
    const s16 = await load('/models/realesr-animevideov3.onnx.fp16', 'webgpu');
    out.fp16Webgpu = (await grayRun(s16)).map((v) => v.toFixed(3)).join(',');
  } catch (e) { out.fp16Webgpu = 'ERR ' + e.message.slice(0, 80); }
  // fp32 WebGPU 中间级（修复后用户机器将走的路径）
  try {
    const s32 = await load('/models/realesr-animevideov3.onnx', 'webgpu');
    out.fp32Webgpu = (await grayRun(s32)).map((v) => v.toFixed(3)).join(',');
  } catch (e) { out.fp32Webgpu = 'ERR ' + e.message.slice(0, 80); }
  // fp32 wasm 地面真值
  try {
    const sw = await load('/models/realesr-animevideov3.onnx', 'wasm');
    out.fp32Wasm = (await grayRun(sw)).map((v) => v.toFixed(3)).join(',');
  } catch (e) { out.fp32Wasm = 'ERR ' + e.message.slice(0, 80); }
  return out;
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
await server.close();
