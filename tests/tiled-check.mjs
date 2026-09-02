// 验证 AI 放大（不勾 keepRes）走分块路径的正确性：真实 1080p 用法必经之路
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-gl=angle'] });
const page = await browser.newPage();
await page.goto('http://localhost:5199/');
await page.waitForTimeout(1000);
const r = await page.evaluate(async () => {
  const { AiEngine } = await import('/src/ai.ts');
  function detailCanvas(w, h) {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#204060'); g.addColorStop(1, '#a0c0e0');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < w * h * 0.08; i++) {
      ctx.fillStyle = `hsl(${(i * 37) % 360},60%,${20 + (i * 13) % 50}%)`;
      ctx.fillRect((i * 7919) % w, (i * 104729) % h, 2, 2);
    }
    ctx.fillStyle = '#fff'; ctx.font = `${Math.floor(h / 8)}px sans-serif`;
    ctx.fillText('TEST 123', w * 0.1, h * 0.5);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    for (let i = 1; i < 6; i++) { ctx.beginPath(); ctx.arc(w * 0.7, h * 0.6, i * w * 0.03, 0, Math.PI * 2); ctx.stroke(); }
    return c;
  }
  const toRgba = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  function edgeEnergy(rgba, w, h) {
    let s = 0, n = 0;
    for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
      const i = (y * w + x) * 4;
      s += Math.abs(rgba[i] - rgba[i + 4]) + Math.abs(rgba[i + 1] - rgba[i + 8]) + Math.abs(rgba[i] - rgba[i + w * 4]) + Math.abs(rgba[i + 1] - rgba[i + w * 4 + 1]);
      n++;
    }
    return s / n;
  }
  const up = (src, w, h) => { const c = new OffscreenCanvas(w, h); c.getContext('2d').drawImage(src, 0, 0, w, h); return c; };
  const ai = await AiEngine.load('imdn-x2', () => {});
  const src = detailCanvas(800, 600);
  const o = await ai.processCanvas(src, {});   // 800x600 > 768 → tiled, no keepRes
  const oRgba = toRgba(o);
  const bil = toRgba(up(src, o.width, o.height));
  let mad = 0; for (let i = 0; i < oRgba.length; i += 4) mad += Math.abs(oRgba[i] - bil[i]) + Math.abs(oRgba[i + 1] - bil[i + 1]) + Math.abs(oRgba[i + 2] - bil[i + 2]);
  mad = mad / (oRgba.length / 4) / 3;
  let black = 0, n = 0;
  for (let i = 0; i < oRgba.length; i += 4) { if (oRgba[i] + oRgba[i + 1] + oRgba[i + 2] === 0) black++; n++; }
  ai.destroy();
  return {
    outSize: `${o.width}x${o.height}`,
    edgeBilinear2x: edgeEnergy(bil, o.width, o.height).toFixed(2),
    edgeAiTiled2x: edgeEnergy(oRgba, o.width, o.height).toFixed(2),
    madVsBilinear: mad.toFixed(2),
    blackFrac: (black / n).toFixed(4),
  };
});
console.log(JSON.stringify(r));
await browser.close(); await server.close();
