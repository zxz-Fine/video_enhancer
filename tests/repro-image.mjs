// 单图复现：node tests/repro-image.mjs <engine> <格式png|jpeg> [wasm]
// 例：node tests/repro-image.mjs realcugan-se-2x-denoise3 png wasm
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import fs from 'node:fs';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const [, , engine = 'imdn-x2', format = 'png', force = ''] = process.argv;
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5197, strictPort: true } });
await server.listen();
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
await page.goto('http://localhost:5197/');
await page.waitForTimeout(1000);
const fileBytes = fs.readFileSync('test_video/Image_2026-08-20_17-43-46_3ptquflu.kwv.png').toString('base64');
const r = await page.evaluate(
  async ({ b64, engine, format, force }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'dog.png', { type: 'image/png' });
    const { enhanceImage } = await import('/src/image.ts');
    const t0 = performance.now();
    const res = await enhanceImage(
      { file, engine, scale: 2, sharpness: 0.6, format, aiForceWasm: force === 'wasm' },
      () => {},
      () => false,
    );
    // 统计左上 128x128 与全图亮度/饱和异常像素
    const bmp = await createImageBitmap(res.blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    off.getContext('2d').drawImage(bmp, 0, 0);
    const ctx = off.getContext('2d');
    const probe = (x0, y0, w, h) => {
      const d = ctx.getImageData(x0, y0, w, h).data;
      let weird = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 16) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        n++;
        // 高饱和原色块：某通道>200 且另两通道<60
        const hot = (r > 200 && g < 60 && b < 60) || (g > 200 && r < 60 && b < 60) || (b > 200 && r < 60 && g < 60);
        if (hot) weird++;
      }
      return { weird, n };
    };
    const tl = probe(0, 0, Math.min(128, bmp.width), Math.min(128, bmp.height));
    const full = probe(0, 0, bmp.width, bmp.height);
    const buf = new Uint8Array(await res.blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { w: res.width, h: res.height, ms: Math.round(performance.now() - t0), tl, full, b64: btoa(bin) };
  },
  { b64: fileBytes, engine, format, force },
);
console.log(JSON.stringify({ w: r.w, h: r.h, ms: r.ms, tl: r.tl, full: r.full }));
fs.writeFileSync(`/tmp/opencode/repro-${engine}.png`, Buffer.from(r.b64, 'base64'));
await browser.close();
await server.close();
console.log('SAVED');
