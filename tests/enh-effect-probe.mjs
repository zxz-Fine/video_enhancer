// 增强效果量化探针：直接调用管线单帧处理，量化输出与输入的差异与锐度变化
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

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
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
page.on('console', (m) => { if (m.text().includes('[dbg]')) console.log('  ', m.text()); });
await page.goto('http://localhost:5199/');
await page.waitForTimeout(1200);

const r = await page.evaluate(
  async () => {
    const { FrameEnhancer } = await import('/src/gpu.ts');
    const { AiEngine } = await import('/src/ai.ts');

    // 生成高细节测试图：渐变 + 噪声 + 文字 + 边缘
    function detailCanvas(w, h) {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#204060');
      g.addColorStop(1, '#a0c0e0');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < w * h * 0.08; i++) {
        ctx.fillStyle = `hsl(${(i * 37) % 360},60%,${20 + (i * 13) % 50}%)`;
        ctx.fillRect((i * 7919) % w, (i * 104729) % h, 2, 2);
      }
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.floor(h / 8)}px sans-serif`;
      ctx.fillText('TEST 123', w * 0.1, h * 0.5);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      for (let i = 1; i < 6; i++) {
        ctx.beginPath();
        ctx.arc(w * 0.7, h * 0.6, i * w * 0.03, 0, Math.PI * 2);
        ctx.stroke();
      }
      return c;
    }

    function toRgba(c) {
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    }
    function mad(a, b) {
      let s = 0;
      for (let i = 0; i < a.length; i += 4) {
        s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      }
      return s / (a.length / 4) / 3;
    }
    // 平均梯度能量（锐度代理）
    function edgeEnergy(rgba, w, h) {
      let s = 0;
      let n = 0;
      for (let y = 1; y < h - 1; y += 2) {
        for (let x = 1; x < w - 1; x += 2) {
          const i = (y * w + x) * 4;
          const dx = Math.abs(rgba[i] - rgba[i + 4]) + Math.abs(rgba[i + 1] - rgba[i + 8]);
          const dy = Math.abs(rgba[i] - rgba[i + w * 4]) + Math.abs(rgba[i + 1] - rgba[i + w * 4 + 1]);
          s += dx + dy;
          n++;
        }
      }
      return s / n;
    }
    function blackFrac(rgba) {
      let z = 0, n = 0;
      for (let i = 0; i < rgba.length; i += 4) { if (rgba[i] + rgba[i + 1] + rgba[i + 2] === 0) z++; n++; }
      return z / n;
    }
    // 把 src 画布缩放到 w×h 后取 RGBA
    function resizedRgba(src, w, h) {
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').drawImage(src, 0, 0, w, h);
      return toRgba(c);
    }

    const out = {};

    // ===== FSR / CAS (WebGPU, headless swiftshader) =====
    try {
      const enh = await FrameEnhancer.create();
      // scale=1 纯 CAS 锐化
      const s1 = detailCanvas(320, 240);
      const inRgba = toRgba(s1);
      const casOut = await enh.processFrame(s1, { scale: 1, sharpness: 0.6, allowBlackFrames: true });
      const casRgba = toRgba(casOut);
      out.cas = {
        mad: mad(inRgba, casRgba).toFixed(2),
        edgeIn: edgeEnergy(inRgba, 320, 240).toFixed(2),
        edgeOut: edgeEnergy(casRgba, 320, 240).toFixed(2),
      };
      // scale=4 FSR：把输出缩回 320x240 与输入比较
      const out4 = await enh.processFrame(s1, { scale: 4, sharpness: 0.6, allowBlackFrames: true });
      const backRgba = resizedRgba(out4, 320, 240);
      out.fsr4x = {
        outSize: `${out4.width}x${out4.height}`,
        madVsInput: mad(inRgba, backRgba).toFixed(2),
        edgeIn: edgeEnergy(inRgba, 320, 240).toFixed(2),
        edgeOutScaledBack: edgeEnergy(backRgba, 320, 240).toFixed(2),
      };
      enh.destroy();
    } catch (e) {
      out.fsrErr = String(e).slice(0, 200);
    }

    // ===== AI imdn-x2 非分块（320x240）=====
    try {
      const ai = await AiEngine.load('imdn-x2', () => {});
      const s = detailCanvas(320, 240);
      const inRgba = toRgba(s);
      const o = await ai.processCanvas(s, {});
      const oRgba = toRgba(o);
      out.aiImdn2x = {
        outSize: `${o.width}x${o.height}`,
        ep: ai.ep,
        madVsBilinearUp: mad(toRgba(await (async () => { const c = new OffscreenCanvas(o.width, o.height); c.getContext('2d').drawImage(s, 0, 0, o.width, o.height); return c; })()), oRgba).toFixed(2),
        edgeIn: edgeEnergy(inRgba, 320, 240).toFixed(2),
        edgeOut: edgeEnergy(oRgba, o.width, o.height).toFixed(2),
      };

      // AI keepRes + 分块（800x600 > 768 → 走分块路径）
      const big = detailCanvas(800, 600);
      const bigRgba = toRgba(big);
      const ok = await ai.processCanvas(big, { keepResolution: true });
      const okRgba = toRgba(ok);
      out.aiKeepResTiled800 = {
        outSize: `${ok.width}x${ok.height}`,
        blackFrac: blackFrac(okRgba).toFixed(3),
        madVsInput: mad(bigRgba, okRgba).toFixed(2),
        edgeIn: edgeEnergy(bigRgba, 800, 600).toFixed(2),
        edgeOut: edgeEnergy(okRgba, 800, 600).toFixed(2),
      };

      // AI keepRes + halfInput 非分块（320x240 → 226x170 → 2x → 452x340 → 缩回 320x240）
      const hk = await ai.processCanvas(s, { keepResolution: true, halfInput: true });
      const hkRgba = toRgba(hk);
      out.aiKeepResHalf240 = {
        outSize: `${hk.width}x${hk.height}`,
        madVsInput: mad(inRgba, hkRgba).toFixed(2),
        edgeIn: edgeEnergy(inRgba, 320, 240).toFixed(2),
        edgeOut: edgeEnergy(hkRgba, 320, 240).toFixed(2),
      };
      ai.destroy();
    } catch (e) {
      out.aiErr = String(e).slice(0, 300);
    }

    // ===== AI realesr-general-x4v3 非分块（320x240）=====
    try {
      const ai2 = await AiEngine.load('realesr-general-x4v3', () => {});
      const s = detailCanvas(320, 240);
      const inRgba = toRgba(s);
      const o = await ai2.processCanvas(s, {});
      const oRgba = toRgba(o);
      out.aiReal4x = {
        outSize: `${o.width}x${o.height}`,
        ep: ai2.ep,
        edgeIn: edgeEnergy(inRgba, 320, 240).toFixed(2),
        edgeOut: edgeEnergy(oRgba, o.width, o.height).toFixed(2),
        madVsBilinearUp: mad(toRgba(await (async () => { const c = new OffscreenCanvas(o.width, o.height); c.getContext('2d').drawImage(s, 0, 0, o.width, o.height); return c; })()), oRgba).toFixed(2),
      };
      ai2.destroy();
    } catch (e) {
      out.aiRealErr = String(e).slice(0, 300);
    }

    return out;
  },
  { timeout: 300000 }
);
console.log(JSON.stringify(r, null, 2));
await browser.close();
await server.close();
