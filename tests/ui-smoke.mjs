// UI 冒烟：所有 main.ts 引用的 id 存在 + 引擎模式联动 + 三模式切换截图
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
const ids = ['drop-zone','file-input','file-meta','controls','scale-group','ai-keep-res-row','ai-keep-res','sharpness','sharpness-value','start-btn','cancel-btn','progress-wrap','progress-bar','status-text','result-section','result-info','original-video','enhanced-video','download-link','error-box','compute-badge','engine-badge','log-panel','log-toggle','loupe-canvas','loupe-play','ai-half-input','enhance-options','ascii-options','ascii-cols','ascii-cols-value','ascii-color','ascii-invert','ascii-threshold','ascii-threshold-value','ascii-bg-color','ascii-fg-color','ascii-preview-canvas','ascii-preview-video','ascii-preview-seek','ascii-preview-play','ascii-preview-time','hw-encode','ai-note','category-group','engine-group','interp-group','interp-row','hw-row','loupe-zoom-group','enhanced-cap','video-compare','image-compare','original-img','enhanced-img','loupe-panel','image-options','image-format-group','jpeg-quality-row','jpeg-quality','jpeg-quality-value','sum-box','engine-video-group','engine-image-group'];
const missing = await page.evaluate((ids) => ids.filter((id) => !document.getElementById(id)), ids);
console.log('missing ids:', missing.length ? missing : 'none');
if (missing.length) process.exitCode = 1;
// 引擎-模式联动：点图片引擎切图片模式，汇总同步
await page.evaluate(() => {
  document.querySelector('#controls').style.display = 'block';
  document.querySelector('input[name="engine"][value="realcugan-se-2x-denoise3"]').click();
});
await page.waitForTimeout(200);
const link = await page.evaluate(() => ({
  engine: document.querySelector('input[name="engine"]:checked').value,
  mode: document.querySelector('input[name="category"]:checked').value,
  sum: document.querySelector('#sum-box').textContent,
}));
console.log('engine-mode link:', JSON.stringify(link));
if (link.mode !== 'image' || !link.sum.includes('图片增强') || !link.sum.includes('表情包修复')) {
  console.log('LINK FAIL');
  process.exitCode = 1;
}
// 切回视频：引擎回到算法，汇总回到视频
await page.evaluate(() => {
  document.querySelector('input[name="engine"][value="fsr"]').click();
});
await page.waitForTimeout(200);
const back = await page.evaluate(() => ({
  mode: document.querySelector('input[name="category"]:checked').value,
  sum: document.querySelector('#sum-box').textContent,
}));
console.log('back to video:', JSON.stringify(back));
if (back.mode !== 'enhance' || !back.sum.includes('1920x1080')) {
  console.log('BACK FAIL');
  process.exitCode = 1;
}
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
