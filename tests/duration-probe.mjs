// 时长回归探针：各模式输出时长/帧数/首尾时间戳
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
await page.waitForTimeout(800);

// 5s @ 30fps = 150 帧测试视频（渐变+移动方块）
const videoB64 = await page.evaluate(async () => {
  const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 240;
  const ctx = canvas.getContext('2d');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
  const source = new mb.CanvasSource(canvas, { codec: 'avc', quality: new mb.Quality({ bitrate: 2e6 }) });
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  for (let i = 0; i < 150; i++) {
    const g = ctx.createLinearGradient(0, 0, 320, 240);
    g.addColorStop(0, `hsl(${i * 2}, 80%, 60%)`);
    g.addColorStop(1, `hsl(${i * 2 + 90}, 90%, 35%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#fff';
    ctx.fillRect(20 + (i % 150) * 2, 100, 40, 40);
    await source.add(i / 30, 1 / 30);
  }
  source.close();
  await output.finalize();
  const buf = new Uint8Array(output.target.buffer);
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
});

const analyze = async (b64) =>
  page.evaluate(async ({ b64 }) => {
    const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');
    const input = new mb.Input({
      formats: mb.ALL_FORMATS,
      source: new mb.BlobSource(new Blob([new Uint8Array(await atob(b64).split('').map((c) => c.charCodeAt(0)))], { type: 'video/mp4' })),
    });
    const vt = await input.getPrimaryVideoTrack();
    const sink = new mb.VideoSampleSink(vt);
    let first = null, last = null, n = 0;
    for await (const s of sink.samples()) {
      if (first === null) first = s.timestamp;
      last = s.timestamp + (s.duration || 0);
      n++;
      s.close();
    }
    return { duration: +(await input.computeDuration()).toFixed(3), packets: n, firstTs: +first.toFixed(3), lastEnd: +last.toFixed(3) };
  }, { b64 });

const runCase = async (name, opts) => {
  const res = await page.evaluate(
    async ({ b64, opts }) => {
      const { enhanceVideo } = await import('/src/enhance.ts');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 't.mp4', { type: 'video/mp4' });
      const r = await enhanceVideo({ file, ...opts }, () => {}, () => false);
      const buf = new Uint8Array(await r.blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    { b64: videoB64, opts },
  );
  const info = await analyze(res);
  console.log(name, JSON.stringify(info));
};

await runCase('enhance 1x   ', { scale: 1, sharpness: 0.6 });
await runCase('ascii 120col ', { scale: 1, sharpness: 0, mode: 'ascii', ascii: { columns: 120, charsetId: 'classic', color: false, invert: false, threshold: 0, bgColor: '#000000', fgColor: '#ffffff' } });
await runCase('enhance 2x   ', { scale: 2, sharpness: 0.6 });

await browser.close();
await server.close();
