import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu'] });
const page = await browser.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(0, 120), r.failure()?.errorText));
await page.goto('http://localhost:5199/');
await page.waitForTimeout(800);
try {
  const r = await page.evaluate(async () => {
    const { AiEngine } = await import('/src/ai.ts');
    const e = await AiEngine.load('imdn-x2', (s, l, t) => console.log('progress:', s, l, t));
    console.log('loaded, scale =', e.scale);
    return true;
  });
  console.log('RESULT:', r);
} catch (e) {
  console.log('LOAD ERR:', e.message.slice(0, 300));
}
await browser.close();
await server.close();
