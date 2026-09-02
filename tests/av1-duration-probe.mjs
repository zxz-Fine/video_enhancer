// AV1 源全管线时长探针：解码 5s AV1 → ASCII/增强 → 输出时长验证
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import fs from 'node:fs';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({
  executablePath: exe, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await page.goto('http://localhost:5199/');
await page.waitForTimeout(800);

const videoB64 = fs.readFileSync('/tmp/test-av1.mp4').toString('base64');
console.log('AV1 file MB:', Math.round((videoB64.length * 3) / 4 / 1048576));

const res = await page.evaluate(
  async ({ b64 }) => {
    const out = {};
    const { enhanceVideo, probeVideo } = await import('/src/enhance.ts');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'av1src.mp4', { type: 'video/mp4' });
    out.probe = await probeVideo(file);
    const mb = await import('/node_modules/mediabunny/dist/modules/src/index.js');

    const analyze = async (blob) => {
      const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(blob) });
      const vt = await input.getPrimaryVideoTrack();
      const sink = new mb.VideoSampleSink(vt);
      let first = null, last = null, n = 0;
      for await (const s of sink.samples()) {
        if (first === null) first = s.timestamp;
        last = s.timestamp + (s.duration || 0);
        n++;
        s.close();
      }
      return { duration: +(await input.computeDuration()).toFixed(2), packets: n, firstTs: +first.toFixed(2), lastEnd: +last.toFixed(2) };
    };

    // 直接解码 AV1 源（不经处理）——验证 sink 是否完整解出 150 帧
    out.rawDecode = await analyze(new Blob([bytes], { type: 'video/mp4' }));

    // ASCII 全管线
    const r1 = await enhanceVideo(
      { file, scale: 1, sharpness: 0, mode: 'ascii', ascii: { columns: 80, charsetId: 'classic', color: false, invert: false, threshold: 0, bgColor: '#000000', fgColor: '#ffffff' } },
      () => {}, () => false,
    );
    out.ascii = { frames: r1.processedFrames, ...(await analyze(r1.blob)) };

    // 增强 1x 全管线
    const r2 = await enhanceVideo({ file, scale: 1, sharpness: 0.6 }, () => {}, () => false);
    out.enhance = { frames: r2.processedFrames, ...(await analyze(r2.blob)) };

    return out;
  },
  { b64: videoB64 },
  { timeout: 300000 },
);
console.log(JSON.stringify(res, null, 2));
await browser.close();
await server.close();
