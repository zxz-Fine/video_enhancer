// 探针：swiftshader 参数下 <video> 帧提取的替代通路
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
  await new Promise((res) => { v.onloadeddata = () => res(null); setTimeout(res, 5000); });
  v.currentTime = 0.1;
  await new Promise((res) => { v.onseeked = () => res(null); setTimeout(res, 5000); });

  const out = {};
  const meanOf = (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { s += d[i] + d[i + 1] + d[i + 2]; n++; }
    return Math.round(s / n / 3);
  };
  // 1. 直接 drawImage
  const c1 = document.createElement('canvas'); c1.width = 160; c1.height = 120;
  c1.getContext('2d').drawImage(v, 0, 0);
  out.drawImage = meanOf(c1);
  // 2. createImageBitmap
  try {
    const bmp = await createImageBitmap(v);
    const c2 = document.createElement('canvas'); c2.width = 160; c2.height = 120;
    c2.getContext('2d').drawImage(bmp, 0, 0);
    out.createImageBitmap = meanOf(c2);
    bmp.close();
  } catch (e) { out.createImageBitmap = 'ERR ' + e.message.slice(0, 60); }
  return out;
});
console.log(JSON.stringify(r));
await browser.close();
await server.close();
