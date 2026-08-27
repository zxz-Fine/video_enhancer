import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import fs from 'node:fs';

const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-angle=swiftshader',
    '--use-gl=angle',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));

await page.goto('http://localhost:5199/');
await page.waitForTimeout(1500);

const gpuSupported = await page.evaluate(async () => {
  if (!navigator.gpu) return false;
  try {
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
});
console.log('WebGPU adapter:', gpuSupported);

const videoB64 = await page.evaluate(async () => {
  const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');
  const output = new mb.Output({
    format: new mb.Mp4OutputFormat(),
    target: new mb.BufferTarget(),
  });
  const source = new mb.CanvasSource(canvas, {
    codec: 'avc',
    quality: new mb.Quality({ bitrate: 2e6 }),
  });
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
    ctx.fillStyle = '#000';
    ctx.font = '20px monospace';
    ctx.fillText(`F${i}`, 250, 220);
    await source.add(i / 30, 1 / 30);
  }
  source.close();
  await output.finalize();
  const buf = new Uint8Array(output.target.buffer);
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
});
console.log('test video bytes:', Buffer.from(videoB64, 'base64').length);

for (const scale of [1, 2, 4]) {
  const result = await page.evaluate(
    async ({ b64, scale }) => {
      const { enhanceVideo } = await import('/src/enhance.ts');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'test.mp4', { type: 'video/mp4' });
      const res = await enhanceVideo(
        { file, scale, sharpness: 0.6, allowBlackFrames: true },
        () => {},
        () => false,
      );
      const buf = new Uint8Array(await res.blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { w: res.width, h: res.height, frames: res.processedFrames, ms: Math.round(res.elapsedMs), size: buf.length, b64: btoa(bin) };
    },
    { b64: videoB64, scale },
  );
  console.log(`scale ${scale}x:`, { out: `${result.w}x${result.h}`, frames: result.frames, ms: result.ms, size: result.size });
  fs.writeFileSync(`/tmp/opencode/out-${scale}x.mp4`, Buffer.from(result.b64, 'base64'));

  // verify output by decoding it again with mediabunny
  const verify = await page.evaluate(
    async ({ b64 }) => {
      const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(new Blob([bytes], { type: 'video/mp4' })) });
      const vt = await input.getPrimaryVideoTrack();
      const stats = await vt.computePacketStats(200);
      return { w: vt.codedWidth, h: vt.codedHeight, packets: stats.packetCount, duration: await input.computeDuration() };
    },
    { b64: result.b64 },
  );
  console.log(`  verify ${scale}x:`, verify);
}

// Timestamp normalization: source starting at 0.5s must produce output starting at 0
const negB64 = await page.evaluate(async () => {
  const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 120;
  const ctx = canvas.getContext('2d');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
  const source = new mb.CanvasSource(canvas, { codec: 'avc', quality: new mb.Quality({ bitrate: 1e6 }) });
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = `hsl(${i * 40}, 80%, 55%)`;
    ctx.fillRect(0, 0, 160, 120);
    await source.add(0.5 + i / 30, 1 / 30);
  }
  source.close();
  await output.finalize();
  const buf = new Uint8Array(output.target.buffer);
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
});
const negResult = await page.evaluate(
  async ({ b64 }) => {
    const { enhanceVideo } = await import('/src/enhance.ts');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'offset.mp4', { type: 'video/mp4' });
    const res = await enhanceVideo({ file, scale: 1, sharpness: 0.6, allowBlackFrames: true }, () => {}, () => false);
    const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');
    const input = new mb.Input({
      formats: mb.ALL_FORMATS,
      source: new mb.BlobSource(new Blob([new Uint8Array(await res.blob.arrayBuffer())])),
    });
    const vt = await input.getPrimaryVideoTrack();
    const firstTs = await vt.getFirstTimestamp();
    const stats = await vt.computePacketStats(100);
    return { frames: res.processedFrames, firstTs, packets: stats.packetCount };
  },
  { b64: negB64 },
);
console.log('offset-ts source:', negResult);
if (negResult.firstTs > 0.01 || negResult.frames !== 8) {
  console.log('TIMESTAMP NORMALIZATION FAIL');
  process.exitCode = 1;
}

// AI engine path (IMDN x2)
const aiResult = await page.evaluate(
  async ({ b64 }) => {
    const { enhanceVideo } = await import('/src/enhance.ts');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'ai.mp4', { type: 'video/mp4' });
    const res = await enhanceVideo(
      { file, scale: 1, sharpness: 0.6, engine: 'imdn-x2', allowBlackFrames: true },
      () => {},
      () => false,
    );
    const buf = new Uint8Array(await res.blob.arrayBuffer());
    const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');
    const input = new mb.Input({
      formats: mb.ALL_FORMATS,
      source: new mb.BlobSource(new Blob([buf])),
    });
    const vt = await input.getPrimaryVideoTrack();
    return { w: res.width, h: res.height, frames: res.processedFrames, size: buf.length, tw: vt.codedWidth, th: vt.codedHeight };
  },
  { b64: videoB64 },
);
console.log('AI IMDN x2:', aiResult);
if (aiResult.w !== 640 || aiResult.frames !== 24 || aiResult.size < 30000) {
  console.log('AI TEST FAIL');
  process.exitCode = 1;
}

// UI flow
await page.setInputFiles('#file-input', {
  name: 'ui-test.mp4',
  mimeType: 'video/mp4',
  buffer: Buffer.from(videoB64, 'base64'),
});
await page.click('#start-btn');
await page.waitForSelector('#result-section', { state: 'visible', timeout: 120000 });
await page.screenshot({ path: '/tmp/opencode/ui-result.png' });
console.log('UI info:', (await page.textContent('#result-info')).trim());

const realErrors = pageErrors.filter((e) => !e.includes('Mediabunny was loaded twice'));
console.log('page errors:', realErrors.length ? realErrors : 'none');

await browser.close();
await server.close();
console.log('E2E DONE');
