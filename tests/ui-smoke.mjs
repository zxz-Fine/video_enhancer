// UI 冒烟：所有 main.ts 引用的 id 存在 + 预设联动 + 三模式切换截图
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5198, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 2200 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5198/');
await page.waitForTimeout(1200);
const ids = ['drop-zone','file-input','file-meta','controls','scale-group','ai-keep-res-row','ai-keep-res','sharpness','sharpness-value','start-btn','cancel-btn','progress-wrap','progress-bar','status-text','result-section','result-info','original-video','enhanced-video','download-link','error-box','compute-badge','engine-badge','log-panel','log-toggle','loupe-canvas','loupe-play','ai-half-input','enhance-options','ascii-options','ascii-cols','ascii-cols-value','ascii-color','ascii-invert','ascii-threshold','ascii-threshold-value','ascii-bg-color','ascii-fg-color','ascii-preview-canvas','ascii-preview-video','ascii-preview-seek','ascii-preview-play','ascii-preview-time','hw-encode','ai-note','category-group','engine-group','interp-group','interp-row','hw-row','loupe-zoom-group','enhanced-cap','video-compare','image-compare','original-img','enhanced-img','loupe-panel','image-options','image-format-group','jpeg-quality-row','jpeg-quality','jpeg-quality-value'];
const missing = await page.evaluate((ids) => ids.filter((id) => !document.getElementById(id)), ids);
console.log('missing ids:', missing.length ? missing : 'none');
// 预设联动
await page.evaluate(() => {
  document.querySelector('#controls').style.display = 'block';
  document.querySelector('[data-preset="meme"]').click();
});
const meme = await page.evaluate(() => ({
  engine: document.querySelector('input[name="engine"]:checked').value,
  keep: document.querySelector('#ai-keep-res').checked,
  row: document.querySelector('#ai-keep-res-row').style.display,
}));
console.log('preset meme:', JSON.stringify(meme));
await page.evaluate(() => document.querySelector('[data-preset="default"]').click());
const def = await page.evaluate(() => ({
  engine: document.querySelector('input[name="engine"]:checked').value,
  sharp: document.querySelector('#sharpness').value,
}));
console.log('preset default:', JSON.stringify(def));
// 三模式切换可见性
for (const v of ['ascii', 'image', 'enhance']) {
  await page.evaluate((v) => {
    document.querySelector(`input[name="category"][value="${v}"]`).click();
  }, v);
  await page.waitForTimeout(200);
  const vis = await page.evaluate(() => ({
    enhance: getComputedStyle(document.querySelector('#enhance-options')).display,
    ascii: getComputedStyle(document.querySelector('#ascii-options')).display,
    image: getComputedStyle(document.querySelector('#image-options')).display,
    interp: getComputedStyle(document.querySelector('#interp-row')).display,
    accept: document.querySelector('#file-input').accept,
  }));
  console.log(`mode ${v}:`, JSON.stringify(vis));
}
await page.screenshot({ path: '/tmp/opencode/ui-new.png' });
// 日志侧栏：复制按钮存在；清空后面板归零
const logUi = await page.evaluate(async () => {
  const hasCopy = !!document.querySelector('#log-copy');
  const hasSide = !!document.querySelector('#log-side');
  const mod = await import('/src/logger.ts');
  mod.log('info', 'smoke-marker');
  const before = document.querySelector('#log-panel').childElementCount;
  mod.clearLogs();
  const after = document.querySelector('#log-panel').childElementCount;
  document.querySelector('#log-copy').click();
  await new Promise((r) => setTimeout(r, 300));
  const warned = [...document.querySelector('#log-panel').children].some((d) => d.textContent.includes('日志为空'));
  return { hasCopy, hasSide, before, after, warned };
});
console.log('log ui:', JSON.stringify(logUi));
if (!logUi.hasCopy || !logUi.hasSide || logUi.before < 1 || logUi.after !== 0 || !logUi.warned) {
  console.log('LOG UI FAIL');
  process.exitCode = 1;
}
console.log('pageerrors:', errs.length ? errs : 'none');
await browser.close();
await server.close();
console.log('SMOKE DONE');
