// 探针：复现 e2e 预览流程，定位黑画布原因
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
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 150)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await page.goto('http://localhost:5199/');
await page.waitForTimeout(800);

const videoB64 = await page.evaluate(async () => {
  const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 240;
  const ctx = canvas.getContext('2d');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
  const source = new mb.CanvasSource(canvas, { codec: 'avc', quality: new mb.Quality({ bitrate: 2e6 }) });
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  for (let i = 0; i < 24; i++) {
    const g = ctx.createLinearGradient(0, 0, 320, 240);
    g.addColorStop(0, `hsl(${i * 15}, 80%, 60%)`);
    g.addColorStop(1, `hsl(${i * 15 + 90}, 90%, 35%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#fff';
    ctx.fillRect(20 + i * 8, 100, 40, 40);
    await source.add(i / 30, 1 / 30);
  }
  source.close();
  await output.finalize();
  const buf = new Uint8Array(output.target.buffer);
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
});

await page.setInputFiles('#file-input', {
  name: 'ui-test.mp4', mimeType: 'video/mp4', buffer: Buffer.from(videoB64, 'base64'),
});
await page.waitForTimeout(800);
await page.click('#category-group label:nth-child(2)');
await page.waitForTimeout(1500);

const dbg = await page.evaluate(async () => {
  const v = document.querySelector('#ascii-preview-video');
  const out = { readyState: v.readyState, videoWidth: v.videoWidth, duration: v.duration, currentTime: v.currentTime };
  const meanOfVideo = () => {
    const c = document.createElement('canvas');
    c.width = 160; c.height = 120;
    c.getContext('2d').drawImage(v, 0, 0, 160, 120);
    const d = c.getContext('2d').getImageData(0, 0, 160, 120).data;
    let s = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { s += d[i] + d[i + 1] + d[i + 2]; n++; }
    return Math.round(s / n / 3);
  };
  out.videoFrameMeanRgbBeforeSeek = v.videoWidth ? meanOfVideo() : null;
  // 强制 seek 触发帧解码
  v.currentTime = 0.1;
  await new Promise((res) => { v.onseeked = () => res(null); setTimeout(res, 5000); });
  out.currentTimeAfterSeek = v.currentTime;
  out.videoFrameMeanRgbAfterSeek = v.videoWidth ? meanOfVideo() : null;
  const pc = document.querySelector('#ascii-preview-canvas');
  if (pc && pc.width) {
    const d = pc.getContext('2d').getImageData(0, 0, pc.width, pc.height).data;
    let s = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { s += d[i] + d[i + 1] + d[i + 2]; n++; }
    out.previewMeanRgb = Math.round(s / n / 3);
  }
  return out;
});
console.log(JSON.stringify(dbg, null, 2));
await browser.close();
await server.close();
