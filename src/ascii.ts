// 视频帧 → ASCII 字符画（纯算法，与参考实现 ascii.luckysnail.cn 同思路：
// 逐格取平均像素 → 计算感知亮度 → 按亮度映射字符梯度 → monospace 逐格绘制）
export interface AsciiOptions {
  columns: number;
  charset: string;
  color: boolean;
  invert: boolean;
}

export interface AsciiJobOptions {
  columns: number;
  charsetId: string;
  color: boolean;
  invert: boolean;
}

export const ASCII_CHARSETS: { id: string; name: string; chars: string }[] = [
  { id: 'classic', name: '经典 10 级', chars: ' .:-=+*#%@' },
  {
    id: 'detailed',
    name: '细致 67 级',
    chars: "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ",
  },
  { id: 'blocks', name: '块状 5 级', chars: ' ░▒▓█' },
];

export function getAsciiCharset(id: string): string {
  return (ASCII_CHARSETS.find((c) => c.id === id) ?? ASCII_CHARSETS[0]).chars;
}

export function asciiConvert(src: OffscreenCanvas, opts: AsciiOptions): OffscreenCanvas {
  const w = src.width;
  const h = src.height;
  const cols = Math.max(16, Math.min(300, Math.round(opts.columns)));
  const cellW = w / cols;

  // monospace 的 advance/em 比随平台字体不同（Consolas ≈0.55，Courier ≈0.6），
  // 先按参考字号实测，再反推字号让字符精确填满单元宽
  const probe = new OffscreenCanvas(8, 8);
  const pctx = probe.getContext('2d')!;
  pctx.font = '100px monospace';
  const advanceRatio = pctx.measureText('M').width / 100 || 0.6;
  const fontPx = Math.max(4, cellW / advanceRatio);
  const cellH = fontPx;
  const rows = Math.max(1, Math.round(h / cellH));

  // 缩到 cols×rows 取每格平均像素（canvas drawImage 自带区域平均）
  const small = new OffscreenCanvas(cols, rows);
  const sctx = small.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(src, 0, 0, cols, rows);
  const data = sctx.getImageData(0, 0, cols, rows).data;

  // 默认黑底白字：暗 → 稀疏字符，亮 → 密集字符；反相则反转梯度并用白底黑字
  let chars = opts.charset;
  if (opts.invert) chars = [...chars].reverse().join('');
  const n = chars.length;
  const bg = opts.invert ? '#ffffff' : '#000000';
  const fg = opts.invert ? '#000000' : '#ffffff';

  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.font = `${fontPx}px monospace`;
  ctx.textBaseline = 'top';
  if (!opts.color) ctx.fillStyle = fg;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const idx = Math.min(n - 1, Math.floor((lum / 255) * n));
      const ch = chars[idx];
      if (ch === ' ') continue;
      if (opts.color) ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillText(ch, x * cellW, y * cellH);
    }
  }
  return out;
}
