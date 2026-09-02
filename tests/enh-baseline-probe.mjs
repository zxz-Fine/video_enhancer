// 基线对比探针：AI 输出 vs bilinear 放大基线；导出 PNG 目视确认 keepRes 分块损坏形态
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await page.goto('http://localhost:5199/');
await page.waitForTimeout(1200);

const r = await page.evaluate(
  async () => {
    const { AiEngine } = await import('/src/ai.ts');

    function detailCanvas(w, h) {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#204060');
      g.addColorStop(1, '#a0c0e0');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < w * h * 0.08; i++) {
        ctx.fillStyle = `hsl(${(i * 37) % 360},60%,${20 + (i * 13) % 50}%)`;
        ctx.fillRect((i * 7919) % w, (i * 104729) % h, 2, 2);
      }
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.floor(h / 8)}px sans-serif`;
      ctx.fillText('TEST 123', w * 0.1, h * 0.5);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      for (let i = 1; i < 6; i++) {
        ctx.beginPath();
        ctx.arc(w * 0.7, h * 0.6, i * w * 0.03, 0, Math.PI * 2);
        ctx.stroke();
      }
      return c;
    }
    const toRgba = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    function edgeEnergy(rgba, w, h) {
      let s = 0, n = 0;
      for (let y = 1; y < h - 1; y += 2) {
        for (let x = 1; x < w - 1; x += 2) {
          const i = (y * w + x) * 4;
          const dx = Math.abs(rgba[i] - rgba[i + 4]) + Math.abs(rgba[i + 1] - rgba[i + 8]);
          const dy = Math.abs(rgba[i] - rgba[i + w * 4]) + Math.abs(rgba[i + 1] - rgba[i + w * 4 + 1]);
          s += dx + dy;
          n++;
        }
      }
      return s / n;
    }
    const up = (src, w, h) => { const c = new OffscreenCanvas(w, h); c.getContext('2d').drawImage(src, 0, 0, w, h); return c; };

    const out = {};
    // 模拟低清源：先把 detail 缩到 160x120，再交给 AI 4x
    const lo = detailCanvas(160, 120);
    const loRgba = toRgba(lo);
    out.loEdge = edgeEnergy(loRgba, 160, 120).toFixed(2);

    const ai = await AiEngine.load('realesr-general-x4v3', () => {});
    const o4 = await ai.processCanvas(lo, {});
    const o4Rgba = toRgba(o4);
    const bil4 = up(lo, 640, 480);
    const bil4Rgba = toRgba(bil4);
    out.realesr4xFrom160 = {
      outSize: `${o4.width}x${o4.height}`,
      edgeBilinear4x: edgeEnergy(bil4Rgba, 640, 480).toFixed(2),
      edgeAi4x: edgeEnergy(o4Rgba, o4.width, o4.height).toFixed(2),
      edgeIn: edgeEnergy(loRgba, 160, 120).toFixed(2),
    };
    // PNG 导出（转成可传输的 blob 数据）
    const blob1 = await o4.convertToBlob({ type: 'image/png' });
    const buf1 = new Uint8Array(await blob1.arrayBuffer());
    let b1 = ''; for (let i = 0; i < buf1.length; i += 0x8000) b1 += String.fromCharCode(...buf1.subarray(i, i + 0x8000));
    out.pngAi4x = btoa(b1);
    const blob2 = await bil4.convertToBlob({ type: 'image/png' });
    const buf2 = new Uint8Array(await blob2.arrayBuffer());
    let b2 = ''; for (let i = 0; i < buf2.length; i += 0x8000) b2 += String.fromCharCode(...buf2.subarray(i, i + 0x8000));
    out.pngBil4x = btoa(b2);
    ai.destroy();

    // keepRes 分块损坏可视化：800x600 keepRes 输出 PNG
    const ai3 = await AiEngine.load('imdn-x2', () => {});
    const big = detailCanvas(800, 600);
    const okc = await ai3.processCanvas(big, { keepResolution: true });
    const blob3 = await okc.convertToBlob({ type: 'image/png' });
    const buf3 = new Uint8Array(await blob3.arrayBuffer());
    let b3 = ''; for (let i = 0; i < buf3.length; i += 0x8000) b3 += String.fromCharCode(...buf3.subarray(i, i + 0x8000));
    out.pngKeepResTiled = btoa(b3);
    ai3.destroy();

    return out;
  },
  { timeout: 300000 }
);

const fs = await import('node:fs');
fs.mkdirSync('/tmp/opencode', { recursive: true });
fs.writeFileSync('/tmp/opencode/ai4x.png', Buffer.from(r.pngAi4x, 'base64'));
fs.writeFileSync('/tmp/opencode/bil4x.png', Buffer.from(r.pngBil4x, 'base64'));
fs.writeFileSync('/tmp/opencode/keepres-tiled.png', Buffer.from(r.pngKeepResTiled, 'base64'));
delete r.pngAi4x; delete r.pngBil4x; delete r.pngKeepResTiled;
console.log(JSON.stringify(r, null, 2));
console.log('PNG saved: /tmp/opencode/{ai4x,bil4x,keepres-tiled}.png');
await browser.close();
await server.close();
