import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import fs from 'node:fs';

const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

fs.mkdirSync('/tmp/opencode', { recursive: true });

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

// AI keepResolution + 大于 768px 的源（走分块路径）：输出必须与源对齐而非撕裂回绕
const keepResResult = await page.evaluate(
  async () => {
    const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 400;
    const ctx = canvas.getContext('2d');
    const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
    const source = new mb.CanvasSource(canvas, { codec: 'avc', quality: new mb.Quality({ bitrate: 4e6 }) });
    output.addVideoTrack(source, { frameRate: 30 });
    await output.start();
    for (let i = 0; i < 4; i++) {
      const g = ctx.createLinearGradient(0, 0, 800, 400);
      g.addColorStop(0, `hsl(${i * 60}, 70%, 55%)`);
      g.addColorStop(1, `hsl(${i * 60 + 120}, 80%, 40%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 800, 400);
      ctx.fillStyle = '#fff';
      ctx.fillRect(100 + i * 100, 150, 80, 80);
      await source.add(i / 30, 1 / 30);
    }
    source.close();
    await output.finalize();
    const bytes = new Uint8Array(output.target.buffer);
    const file = new File([bytes], 'keepres.mp4', { type: 'video/mp4' });

    const { enhanceVideo } = await import('/src/enhance.ts');
    const res = await enhanceVideo(
      { file, scale: 1, sharpness: 0.6, engine: 'imdn-x2', aiKeepResolution: true, allowBlackFrames: true },
      () => {},
      () => false,
    );
    if (res.width !== 800 || res.height !== 400) {
      return { fail: `输出尺寸 ${res.width}x${res.height} ≠ 800x400` };
    }
    // 首帧 MAD：撕裂回绕时 >15，正常 AI 修复应接近原图
    const firstFrame = async (blob) => {
      const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(new Blob([new Uint8Array(await blob.arrayBuffer())])) });
      const vt = await input.getPrimaryVideoTrack();
      const sink = new mb.VideoSampleSink(vt);
      for await (const s of sink.samples()) {
        const c = new OffscreenCanvas(s.displayWidth, s.displayHeight);
        s.draw(c.getContext('2d'), 0, 0, s.displayWidth, s.displayHeight);
        s.close();
        return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      }
      return null;
    };
    const a = await firstFrame(new Blob([bytes], { type: 'video/mp4' }));
    const b = await firstFrame(res.blob);
    if (!a || !b || a.length !== b.length) return { fail: '无法解码首帧对比' };
    let mad = 0;
    for (let i = 0; i < a.length; i += 4) {
      mad += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    }
    mad = mad / (a.length / 4) / 3;
    return { w: res.width, h: res.height, frames: res.processedFrames, mad: Math.round(mad * 100) / 100 };
  },
);
console.log('AI keepRes tiled (800x400):', keepResResult);
if (keepResResult.fail || keepResResult.mad > 8) {
  console.log('KEEPRES TILED TEST FAIL (撕裂/错位或尺寸不符)');
  process.exitCode = 1;
}

// Interpolation x2 (RIFE)
const interpResult = await page.evaluate(
  async ({ b64 }) => {
    const { enhanceVideo } = await import('/src/enhance.ts');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'interp.mp4', { type: 'video/mp4' });
    const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');
    let mid = 0;
    const res = await enhanceVideo(
      { file, scale: 1, sharpness: 0.3, engine: 'fsr', interpolation: 'x2', allowBlackFrames: true },
      () => {},
      () => false,
    );
    const input = new mb.Input({
      formats: mb.ALL_FORMATS,
      source: new mb.BlobSource(new Blob([new Uint8Array(await res.blob.arrayBuffer())])),
    });
    const vt = await input.getPrimaryVideoTrack();
    const stats = await vt.computePacketStats(500);
    const fpsOut = stats.averagePacketRate;
    return { packets: stats.packetCount, fpsOut: fpsOut.toFixed(1), duration: (await input.computeDuration()).toFixed(2) };
  },
  { b64: videoB64 },
);
console.log('interp x2:', interpResult);
if (interpResult.packets < 45 || interpResult.packets > 49) {
  console.log('INTERP TEST FAIL (expected ~47-48 packets)');
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
