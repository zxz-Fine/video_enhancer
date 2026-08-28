import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import fs from 'node:fs';

const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const server = await createServer({ configFile: false, root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[dbg]') || t.includes('[AI]')) console.log('[console]', t.slice(0, 180));
});
await page.goto('http://localhost:5199/');
await page.waitForTimeout(800);

const r = await page.evaluate(async () => {
  const { AiEngine } = await import('/src/ai.ts');
  const e = await AiEngine.load('imdn-x2', () => {});
  const W = 1600;
  const H = 900;
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#3a7bd5');
  g.addColorStop(1, '#e8c547');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  x.fillStyle = 'rgba(255,255,255,0.15)';
  for (let i = 0; i < W; i += 80) x.fillRect(i, 0, 40, H);

  const t0 = performance.now();
  const oc = await e.processCanvas(c, { halfInput: true, keepResolution: true });
  const ms = Math.round(performance.now() - t0);

  const octx = oc.getContext('2d');
  const img = octx.getImageData(0, 0, W, H).data;

  const rowBlack = {};
  for (let yy = 0; yy < 8; yy++) {
    let cnt = 0;
    for (let xx = 0; xx < W; xx += 5) {
      const i = (yy * W + xx) * 4;
      if (img[i] + img[i + 1] + img[i + 2] === 0) cnt++;
    }
    rowBlack['y' + yy] = cnt;
  }

  function colDiff(xc) {
    let d = 0;
    for (let yy = 100; yy < 800; yy += 7) {
      const i = (yy * W + xc) * 4;
      d += Math.abs(img[i] - img[i - 4]) + Math.abs(img[i + 1] - img[i - 3]);
    }
    return d;
  }
  const junction = Math.round(736 * (W / 1131));
  const diffs = [];
  for (let xc = 800; xc < 1300; xc += 4) diffs.push([xc, colDiff(xc)]);
  diffs.sort((a, b) => a[0] - b[0]);
  const near = diffs.filter(([xc]) => Math.abs(xc - junction) <= 12).map(([, v]) => v);
  const far = diffs.filter(([xc]) => Math.abs(xc - junction) > 60).map(([, v]) => v);
  const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const nearMax = Math.max(...near);
  const farMedian = median(far);

  const pngBlob = await oc.convertToBlob({ type: 'image/png' });
  const pngBuf = new Uint8Array(await pngBlob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < pngBuf.length; i += 0x8000) bin += String.fromCharCode(...pngBuf.subarray(i, i + 0x8000));

  return { ms, dims: oc.width + 'x' + oc.height, rowBlack, junction, nearMax, farMedian, sample0: [img[0], img[1], img[2]], pngB64: btoa(bin) };
});

console.log(JSON.stringify({ ms: r.ms, dims: r.dims, rowBlack: r.rowBlack, junction: r.junction, nearMax: r.nearMax, farMedian: r.farMedian }));
fs.writeFileSync('/tmp/opencode/seam-out.png', Buffer.from(r.pngB64, 'base64'));

const topBlack = Object.values(r.rowBlack).some((v) => v > 0);
const seamOk = r.nearMax < Math.max(150, r.farMedian * 1.8);
console.log(topBlack ? 'FAIL: black band' : seamOk ? 'SEAM TEST PASS' : 'FAIL: seam visible (near=' + r.nearMax + ' far=' + r.farMedian + ')');
process.exit(topBlack || !seamOk ? 1 : 0);
await browser.close();
await server.close();
process.exit(topBlack ? 1 : 0);
