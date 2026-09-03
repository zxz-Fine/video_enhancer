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
  const ai = await AiEngine.load('realesr-animevideov3', () => {});
  const ep = ai.ep;
  // 实跑一帧验证输出非零
  const c = new OffscreenCanvas(64, 48);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 64, 48);
  g.addColorStop(0, '#8040ff'); g.addColorStop(1, '#ff8000');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 48);
  const out = await ai.processCanvas(c, {});
  const d = out.getContext('2d').getImageData(0, 0, out.width, out.height).data;
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 97) { sum += d[i] + d[i + 1] + d[i + 2]; n++; }
  ai.destroy();
  return { ep, outSize: out.width + 'x' + out.height, meanRgb: Math.round(sum / n / 3) };
});
console.log(JSON.stringify(r));
await browser.close(); await server.close();
