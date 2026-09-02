// 探针：headless 下 <video> seek + drawImage 是否产出真实像素
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://localhost:5199/');
await page.waitForTimeout(500);
const r = await page.evaluate(async () => {
  const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');
  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = 120;
  const ctx = canvas.getContext('2d');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
  const source = new mb.CanvasSource(canvas, { codec: 'avc', quality: new mb.Quality({ bitrate: 1e6 }) });
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = `hsl(${i * 45}, 90%, 60%)`;
    ctx.fillRect(0, 0, 160, 120);
    ctx.fillStyle = '#fff';
    ctx.fillRect(30 + i * 10, 30, 40, 40);
    await source.add(i / 30, 1 / 30);
  }
  source.close();
  await output.finalize();
  const blob = new Blob([new Uint8Array(output.target.buffer)], { type: 'video/mp4' });

  const v = document.createElement('video');
  v.muted = true;
  v.src = URL.createObjectURL(blob);
  const info = {};
  await new Promise((res) => {
    v.onloadeddata = () => res(null);
    v.onerror = () => res(null);
    setTimeout(res, 5000);
  });
  info.readyState = v.readyState;
  info.duration = v.duration;
  v.currentTime = 0.1;
  await new Promise((res) => {
    v.onseeked = () => res(null);
    setTimeout(res, 5000);
  });
  const c = document.createElement('canvas');
  c.width = 160; c.height = 120;
  c.getContext('2d').drawImage(v, 0, 0);
  const d = c.getContext('2d').getImageData(0, 0, 160, 120).data;
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; n++; }
  info.meanRgb = Math.round(sum / n / 3);
  return info;
});
console.log(JSON.stringify(r));
await browser.close();
await server.close();
