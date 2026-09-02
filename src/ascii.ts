// 视频帧 → ASCII 字符画（纯算法，与参考实现 ascii.luckysnail.cn 同思路：
// 逐格取平均像素 → 计算感知亮度 → 按亮度映射字符梯度 → monospace 逐格绘制）
// 预设与阈值设计参考 asciistudio.space（vansh-nagar/ascii-studio）
export interface AsciiOptions {
  columns: number;
  charset: string;
  /** 保留原像素颜色（每格按平均色着色） */
  color: boolean;
  /** 仅反转字符梯度（亮部用稀疏字符）；底色/字色由 bgColor/fgColor 决定 */
  invert: boolean;
  /** 亮度阈值 0-100：低于该百分比的格子留空，去除暗部噪点 */
  threshold: number;
  bgColor: string;
  fgColor: string;
}

export interface AsciiJobOptions {
  columns: number;
  charsetId: string;
  color: boolean;
  invert: boolean;
  threshold: number;
  bgColor: string;
  fgColor: string;
}

export const ASCII_CHARSETS: { id: string; name: string; chars: string }[] = [
  { id: 'classic', name: '经典 10 级', chars: ' .:-=+*#%@' },
  {
    id: 'standard',
    name: '细腻 70 级',
    chars: " .'`^,:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  },
  { id: 'matrix', name: '矩阵', chars: ' .:░▒▓█' },
  { id: 'pixel', name: '像素块', chars: ' ░▒▓█▇▆▅▄▃▂▁' },
  { id: 'circles', name: '圆点', chars: ' ·•●⬤' },
  { id: 'braille', name: '盲文点', chars: ' ⠁⠃⠇⠧⠷⠿' },
  { id: 'scanlines', name: '扫描线', chars: ' .:-=|/\\#' },
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

  let chars = opts.charset;
  if (opts.invert) chars = [...chars].reverse().join('');
  const n = chars.length;
  const t = (Math.max(0, Math.min(100, opts.threshold)) / 100) * 255;

  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = opts.bgColor || '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.font = `${fontPx}px monospace`;
  ctx.textBaseline = 'top';
  if (!opts.color) ctx.fillStyle = opts.fgColor || '#ffffff';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum < t) continue;
      const idx = Math.min(n - 1, Math.floor((lum / 255) * n));
      const ch = chars[idx];
      if (ch === ' ') continue;
      if (opts.color) ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillText(ch, x * cellW, y * cellH);
    }
  }
  return out;
}
