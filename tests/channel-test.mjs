import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.text().includes('[probe]')) console.log(m.text());
});
await page.goto('http://localhost:5199/');
await page.waitForTimeout(800);
const r = await page.evaluate(async () => {
  const { AiEngine } = await import('/src/ai.ts');
  const e = await AiEngine.load('imdn-x2', () => {});
  const colors = [[255,0,0],[0,255,0],[0,0,255],[255,255,0],[128,128,128]];
  const out = {};
  for (const [R,G,B] of colors) {
    const c = new OffscreenCanvas(32, 32);
    const x = c.getContext('2d');
    x.fillStyle = `rgb(${R},${G},${B})`;
    x.fillRect(0, 0, 32, 32);
    const oc = await e.processCanvas(c);
    const octx = oc.getContext('2d');
    const img = octx.getImageData(16, 16, 1, 1).data;
    out[`in(${R},${G},${B})`] = `out(${img[0]},${img[1]},${img[2]})`;
  }
  return { ep: e.ep, samples: out };
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
await server.close();
