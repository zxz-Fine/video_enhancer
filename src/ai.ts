import * as ort from 'onnxruntime-web';
import { getModel, type ModelInfo } from './models';
import { log } from './logger';
import ortMjs from './ort-assets/ort-wasm-simd-threaded.jsep.mjs?url';
import ortWasm from './ort-assets/ort-wasm-simd-threaded.jsep.wasm?url';

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };

export type AiProgress = (stage: 'fetch' | 'compile' | 'ready', loaded?: number, total?: number) => void;

export interface AiRunOptions {
  /** 半分辨率推理：源先缩小，输出再回到目标尺寸，计算量约降 4 倍 */
  halfInput?: boolean;
  /** 推理后缩回源分辨率 */
  keepResolution?: boolean;
}

export class AiEngine {
  private session: ort.InferenceSession | null = null;
  private model: ModelInfo;
  private inputName: string;
  private outputName: string;
  private tile = 512;
  private _ep: 'webgpu' | 'wasm' = 'wasm';

  private constructor(session: ort.InferenceSession, model: ModelInfo, ep: 'webgpu' | 'wasm') {
    this.session = session;
    this.model = model;
    this._ep = ep;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
  }

  get ep(): 'webgpu' | 'wasm' {
    return this._ep;
  }

  static async load(modelId: string, onProgress: AiProgress): Promise<AiEngine> {
    const model = getModel(modelId);
    log('ai', `引擎加载: ${model.name} (${model.sizeMB}MB, ${model.scale}x)`);
    onProgress('fetch', 0, 1);

    const fetchModel = async (file: string): Promise<Uint8Array> => {
      try {
        const cache = await caches.open('ai-models');
        let resp = await cache.match(file);
        if (!resp) {
          const fetched = await fetch(file);
          if (!fetched.ok) throw new Error(`模型下载失败 HTTP ${fetched.status}`);
          await cache.put(file, fetched.clone());
          resp = await cache.match(file);
        }
        return new Uint8Array(await (resp as Response).arrayBuffer());
      } catch {
        const resp = await fetch(file);
        if (!resp.ok) throw new Error(`模型下载失败 HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
      }
    };

    const create = async (data: Uint8Array, eps: string[]) =>
      ort.InferenceSession.create(data, {
        executionProviders: eps,
        graphOptimizationLevel: 'all',
      });

    onProgress('compile');
    let session: ort.InferenceSession | null = null;
    let ep: 'webgpu' | 'wasm' = 'wasm';
    let webgpuErr = '';
    if (navigator.gpu) {
      try {
        const ad = await navigator.gpu.requestAdapter();
        if (!ad) throw new Error('requestAdapter 返回空');
        const hasF16 = ad.features.has('shader-f16');
        log('gpu', `AI 引擎探测: ${ad.info?.description || ad.info?.vendor || '适配器'}, shader-f16=${hasF16}`);
        const gpuFile = hasF16 ? model.file + '.fp16' : model.file;
        log('ai', `尝试 WebGPU 推理（${hasF16 ? 'fp16' : 'fp32'} 模型）…`);
        session = await create(await fetchModel(gpuFile), ['webgpu']);
        ep = 'webgpu';
        log('gpu', `WebGPU 会话创建成功（${hasF16 ? 'fp16 加速' : 'fp32'}）`);
      } catch (e) {
        webgpuErr = e instanceof Error ? e.message : String(e);
        log('warn', `WebGPU EP 初始化失败: ${webgpuErr.slice(0, 180)}`);
      }
    } else {
      webgpuErr = '浏览器无 WebGPU';
      log('warn', '浏览器无 WebGPU，将使用 CPU 推理');
    }
    if (session && ep === 'webgpu') {
      const ok = await AiEngine.warmupCheck(
        session,
        session.inputNames[0],
        session.outputNames[0],
        model.inputRange,
      );
      if (!ok) {
        log('warn', 'WebGPU warmup 自检输出全零 → 回退 CPU 推理');
        await session.release();
        session = null;
      } else {
        log('gpu', 'warmup 自检通过，GPU 推理可用');
      }
    }
    if (!session) {
      log('ai', `加载 fp32 模型（CPU 推理）…`);
      session = await create(await fetchModel(model.file), ['wasm']);
      ep = 'wasm';
    }
    if (ep === 'wasm') {
      log('warn', `最终推理后端: CPU (wasm, ${ort.env.wasm.numThreads} 线程)。速度比 GPU 慢 10 倍以上。`);
    } else {
      log('gpu', `最终推理后端: GPU (WebGPU)`);
    }
    log('ai', '引擎就绪');
    if (ep === 'wasm' && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
      ort.env.wasm.numThreads = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
    }
    onProgress('ready');
    return new AiEngine(session, model, ep);
  }

  static async warmupCheck(
    session: ort.InferenceSession,
    inputName: string,
    outputName: string,
    inputRange: number,
  ): Promise<boolean> {
    const S = 48;
    const px = S * S;
    const grey = (0.5 * inputRange) as number;
    const chw = new Float32Array(3 * px).fill(grey);
    try {
      const out = await session.run({ [inputName]: new ort.Tensor('float32', chw, [1, 3, S, S]) });
      const data = out[outputName].data as Float32Array;
      const dims = out[outputName].dims;
      const ow = dims[3];
      const oh = dims[2];
      const stride = ow * oh;
      let ok = true;
      const samples = [8, 24, 40];
      for (const sy of samples) {
        for (const sx of samples) {
          const i = sy * ow + sx;
          const r = data[i];
          const g = data[stride + i];
          const b = data[stride * 2 + i];
          const mean = (r + g + b) / 3;
          const spread = Math.max(Math.abs(r - mean), Math.abs(g - mean), Math.abs(b - mean));
          if (spread > inputRange * 0.08 || Math.abs(mean - grey) > inputRange * 0.2) {
            ok = false;
          }
        }
      }
      return ok;
    } catch {
      return false;
    }
  }



  get scale(): 2 | 4 {
    return this.model.scale;
  }

  get info(): ModelInfo {
    return this.model;
  }

  async processCanvas(src: OffscreenCanvas, runOpts?: AiRunOptions): Promise<OffscreenCanvas> {
    let work: OffscreenCanvas = src;
    if (runOpts?.halfInput) {
      const k = 1 / Math.sqrt(this.model.scale);
      work = new OffscreenCanvas(Math.round(src.width * k), Math.round(src.height * k));
      work.getContext('2d')!.drawImage(src, 0, 0, work.width, work.height);
      log('ai', `性能模式: 推理输入 ${work.width}x${work.height} (源 ${src.width}x${src.height})`);
    }
    const w = work.width;
    const h = work.height;
    const ctx = work.getContext('2d')!;
    const img = ctx.getImageData(0, 0, w, h);

    const useTile = w > this.tile || h > this.tile;
    const targetW = runOpts?.keepResolution ? src.width : w * this.model.scale;
    const targetH = runOpts?.keepResolution ? src.height : h * this.model.scale;
    const finalRgba = new Uint8ClampedArray(targetW * targetH * 4);

    if (!useTile) {
      const out = await this.inferTensor(img.data, w, h);
      const rgba = this.chwToRgba(out.data, out.w, out.h);
      blitScaled(rgba, out.w, out.h, finalRgba, targetW, 0, 0, out.w, out.h, 0, 0);
      const outCanvas = new OffscreenCanvas(targetW, targetH);
      outCanvas.getContext('2d')!.putImageData(new ImageData(finalRgba, targetW, targetH), 0, 0);
      return outCanvas;
    }

    const ov = 16;
    const tileScale = this.model.scale;
    for (let y = 0; y < h; y += this.tile - ov * 2) {
      for (let x = 0; x < w; x += this.tile - ov * 2) {
        const sx = Math.max(0, x - ov);
        const sy = Math.max(0, y - ov);
        const ex = Math.min(w, x + this.tile - ov);
        const ey = Math.min(h, y + this.tile - ov);
        const tw = ex - sx;
        const th = ey - sy;
        if (tw <= 0 || th <= 0) continue;

        const patch = new Uint8ClampedArray(tw * th * 4);
        for (let row = 0; row < th; row++) {
          const srcRow = ((sy + row) * w + sx) * 4;
          patch.set(img.data.subarray(srcRow, srcRow + tw * 4), row * tw * 4);
        }
        const outTile = await this.inferTensor(patch, tw, th);
        const fx = outTile.w / (tw * tileScale);
        const fy = outTile.h / (th * tileScale);

        const cx0 = Math.max(x, sx + ov) * tileScale;
        const cy0 = Math.max(y, sy + ov) * tileScale;
        const cx1 = Math.min(ex, x + this.tile - ov) * tileScale;
        const cy1 = Math.min(ey, y + this.tile - ov) * tileScale;

        const tileRgba = this.chwToRgba(outTile.data, outTile.w, outTile.h);
        blitScaled(
          tileRgba,
          outTile.w,
          outTile.h,
          finalRgba,
          targetW,
          (cx0 - sx * tileScale) * fx,
          (cy0 - sy * tileScale) * fy,
          (cx1 - cx0) * fx,
          (cy1 - cy0) * fy,
          cx0,
          cy0,
        );
      }
    }
    const outCanvas = new OffscreenCanvas(targetW, targetH);
    outCanvas.getContext('2d')!.putImageData(new ImageData(finalRgba, targetW, targetH), 0, 0);
    return outCanvas;
  }

  private async inferTensor(
    rgba: Uint8ClampedArray,
    w: number,
    h: number,
  ): Promise<{ data: Float32Array; w: number; h: number }> {
    const k = this.model.inputRange === 255 ? 1 : 1 / 255;
    const chw = new Float32Array(3 * w * h);
    const px = w * h;
    for (let i = 0; i < px; i++) {
      chw[i] = rgba[i * 4] * k;
      chw[px + i] = rgba[i * 4 + 1] * k;
      chw[px * 2 + i] = rgba[i * 4 + 2] * k;
    }
    const input = new ort.Tensor('float32', chw, [1, 3, h, w]);
    const feeds: Record<string, ort.Tensor> = { [this.inputName]: input };
    const results = await this.session!.run(feeds);
    const t = results[this.outputName];
    return { data: t.data as Float32Array, w: t.dims[3], h: t.dims[2] };
  }

  private chwToRgba(data: Float32Array, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
    const range = this.model.inputRange;
    const px = w * h;
    const rgba = new Uint8ClampedArray(px * 4);
    for (let i = 0; i < px; i++) {
      rgba[i * 4] = toByte(data[i], range);
      rgba[i * 4 + 1] = toByte(data[px + i], range);
      rgba[i * 4 + 2] = toByte(data[px * 2 + i], range);
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }

  destroy(): void {
    this.session?.release().catch(() => {});
    this.session = null;
  }
}

function toByte(v: number, range: number): number {
  if (v <= 0) return 0;
  if (v >= range) return 255;
  return (v / range) * 255;
}

function blitScaled(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dst: Uint8ClampedArray,
  dW: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  dx: number,
  dy: number,
): void {
  const xRatio = sw / rw;
  const yRatio = sh / rh;
  for (let y = 0; y < rh; y++) {
    const fy = ry + (y + 0.5) * yRatio - 0.5;
    let y0 = Math.floor(fy);
    const wy = fy - y0;
    if (y0 < 0) y0 = 0;
    if (y0 >= sh) y0 = sh - 1;
    let y1 = y0 + 1;
    if (y1 >= sh) y1 = sh - 1;
    const rowA = y0 * sw;
    const rowB = y1 * sw;
    let di = ((dy + y) * dW + dx) * 4;
    for (let x = 0; x < rw; x++) {
      const fx = rx + (x + 0.5) * xRatio - 0.5;
      let x0 = Math.floor(fx);
      const wx = fx - x0;
      if (x0 < 0) x0 = 0;
      if (x0 >= sw) x0 = sw - 1;
      let x1 = x0 + 1;
      if (x1 >= sw) x1 = sw - 1;
      const i00 = (rowA + x0) * 4;
      const i10 = (rowA + x1) * 4;
      const i01 = (rowB + x0) * 4;
      const i11 = (rowB + x1) * 4;
      const w00 = (1 - wx) * (1 - wy);
      const w10 = wx * (1 - wy);
      const w01 = (1 - wx) * wy;
      const w11 = wx * wy;
      dst[di] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      dst[di + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      dst[di + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      dst[di + 3] = 255;
      di += 4;
    }
  }
}

export async function listCachedModels(): Promise<Record<string, boolean>> {
  try {
    const cache = await caches.open('ai-models');
    const out: Record<string, boolean> = {};
    for (const m of (await import('./models')).AI_MODELS) {
      out[m.id] = !!(await cache.match(m.file));
    }
    return out;
  } catch {
    return {};
  }
}
