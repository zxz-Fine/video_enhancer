import { FrameEnhancer, type ScaleFactor } from './gpu';
import { AiEngine } from './ai';
import { log } from './logger';

export interface ImageEnhanceOptions {
  file: File;
  /** 'fsr' 或 AI 模型 id */
  engine: string;
  /** 算法引擎缩放（AI 忽略，自带倍数） */
  scale: ScaleFactor;
  sharpness: number;
  aiKeepResolution?: boolean;
  aiHalfInput?: boolean;
  format: 'png' | 'jpeg';
  /** jpeg 质量 0..1 */
  jpegQuality?: number;
  /** 输入长边上限，超了先等比缩（默认 2048，防爆显存） */
  maxInputDim?: number;
  /** 测试专用：跳过 WebGPU，直接 wasm */
  aiForceWasm?: boolean;
  /** 测试专用：允许全黑输出 */
  allowBlackFrames?: boolean;
}

export interface ImageEnhanceResult {
  blob: Blob;
  width: number;
  height: number;
  elapsedMs: number;
}

function roundEven(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r - 1;
}

export async function enhanceImage(
  options: ImageEnhanceOptions,
  onProgress?: (phase: 'decode' | 'model' | 'infer' | 'encode') => void,
  shouldCancel?: () => boolean,
): Promise<ImageEnhanceResult> {
  const start = performance.now();
  const maxDim = options.maxInputDim ?? 2048;
  log('info', `图片任务开始: ${options.file.name} (${(options.file.size / 1024).toFixed(0)}KB, ${options.file.type || '未知类型'})`);
  onProgress?.('decode');

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(options.file, { imageOrientation: 'from-image' });
  } catch (e) {
    throw new Error(
      `图片解码失败（可能是 HEIC/特殊格式，浏览器不支持）。可先转码为 PNG/JPEG 再试。原始错误：${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  let srcW = bitmap.width;
  let srcH = bitmap.height;
  log('info', `图片解码: ${srcW}x${srcH}`);
  if (Math.max(srcW, srcH) > maxDim) {
    const k = maxDim / Math.max(srcW, srcH);
    srcW = Math.round(srcW * k);
    srcH = Math.round(srcH * k);
    log('info', `输入超 ${maxDim}px 上限，先等比缩到 ${srcW}x${srcH} 再增强`);
  }
  const src = new OffscreenCanvas(srcW, srcH);
  const sctx = src.getContext('2d')!;
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(bitmap, 0, 0, srcW, srcH);
  bitmap.close();
  if (shouldCancel?.()) throw new Error('已取消。');

  const engine = options.engine && options.engine !== 'fsr' ? options.engine : null;
  const keepRes = !!engine && !!options.aiKeepResolution;
  log('info', `图片引擎: ${engine ?? `算法增强 (FSR${options.scale}x)`}${engine ? '' : `, 锐度 ${Math.round(options.sharpness * 100)}%`}`);
  onProgress?.('model');

  let ai: AiEngine | null = null;
  if (engine) {
    ai = await AiEngine.load(
      engine,
      () => {},
      { forceWasm: options.aiForceWasm },
    );
    log('info', `图片 AI 后端=${ai.ep}`);
  }
  let enhancer: FrameEnhancer | null = null;
  if (!engine) enhancer = await FrameEnhancer.create();
  if (shouldCancel?.()) {
    ai?.destroy();
    enhancer?.destroy();
    throw new Error('已取消。');
  }

  onProgress?.('infer');
  const tInfer = performance.now();
  let out: OffscreenCanvas;
  if (ai) {
    out = await ai.processCanvas(src, { halfInput: options.aiHalfInput, keepResolution: options.aiKeepResolution });
  } else {
    out = await enhancer!.processFrame(src, {
      scale: options.scale,
      sharpness: options.sharpness,
      allowBlackFrames: options.allowBlackFrames,
    });
  }
  // keepRes 缩回源尺寸 + 4K 上限（与视频 finalizeFrame 同策略）
  if (ai && keepRes && (out.width !== srcW || out.height !== srcH)) {
    const back = new OffscreenCanvas(srcW, srcH);
    back.getContext('2d')!.drawImage(out, 0, 0, srcW, srcH);
    out = back;
  }
  if (out.width * out.height > 3840 * 2160) {
    const k = Math.min(3840 / out.width, 2160 / out.height);
    const cw = roundEven(out.width * k);
    const ch = roundEven(out.height * k);
    const scaled = new OffscreenCanvas(cw, ch);
    scaled.getContext('2d')!.drawImage(out, 0, 0, cw, ch);
    out = scaled;
    log('info', `图片输出超 4K，已限制到 ${cw}x${ch}`);
  }
  log('info', `图片推理完成: ${srcW}x${srcH} → ${out.width}x${out.height}, ${Math.round(performance.now() - tInfer)}ms`);
  ai?.destroy();
  enhancer?.destroy();
  if (shouldCancel?.()) throw new Error('已取消。');

  onProgress?.('encode');
  const mime = options.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await out.convertToBlob({
    type: mime,
    quality: options.format === 'jpeg' ? (options.jpegQuality ?? 0.92) : undefined,
  });
  log('info', `图片编码完成: ${mime} ${(blob.size / 1024).toFixed(0)}KB，总耗时 ${((performance.now() - start) / 1000).toFixed(1)}s`);
  return { blob, width: out.width, height: out.height, elapsedMs: performance.now() - start };
}
