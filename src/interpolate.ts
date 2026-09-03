import * as ort from 'onnxruntime-web';
import { log } from './logger';
import ortMjs from './ort-assets/ort-wasm-simd-threaded.jsep.mjs?url';
import ortWasm from './ort-assets/ort-wasm-simd-threaded.jsep.wasm?url';

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };

export class FrameInterpolator {
  private session: ort.InferenceSession | null = null;
  private activeEp: 'webgpu' | 'wasm' = 'wasm';
  private gridCache = new Map<string, ort.Tensor>();
  private rebuiltOnCpu = false;
  private loggedPad = '';

  private constructor(session: ort.InferenceSession, ep: 'webgpu' | 'wasm') {
    this.session = session;
    this.activeEp = ep;
  }

  get ep(): 'webgpu' | 'wasm' {
    return this.rebuiltOnCpu ? 'wasm' : this.activeEp;
  }

  private static async fetchModelData(): Promise<Uint8Array> {
    const file = '/models/rife422-lite.onnx';
    try {
      const cache = await caches.open('ai-models');
      let resp = await cache.match(file);
      if (!resp) {
        const fetched = await fetch(file);
        if (!fetched.ok) throw new Error(`HTTP ${fetched.status}`);
        await cache.put(file, fetched.clone());
        resp = await cache.match(file);
      }
      return new Uint8Array(await (resp as Response).arrayBuffer());
    } catch {
      const resp = await fetch(file);
      if (!resp.ok) throw new Error(`模型下载失败 HTTP ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    }
  }

  static async load(): Promise<FrameInterpolator> {
    const t0 = performance.now();
    log('ai', 'RIFE 插帧引擎加载开始');
    let session: ort.InferenceSession | null = null;
    let ep: 'webgpu' | 'wasm' = 'wasm';
    if (navigator.gpu) {
      try {
        session = await ort.InferenceSession.create(await FrameInterpolator.fetchModelData(), {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        });
        if (!(await FrameInterpolator.warmupCheck(session))) {
          log('warn', 'RIFE WebGPU warmup 自检未通过（内核不支持或输出异常）→ 回退 CPU');
          await session.release();
          session = null;
        } else {
          ep = 'webgpu';
          log('gpu', `RIFE 插帧: WebGPU 会话创建成功（${Math.round(performance.now() - t0)}ms）`);
        }
      } catch (e) {
        log('warn', `RIFE WebGPU 初始化失败，回退 CPU: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
        session = null;
      }
    } else {
      log('warn', 'RIFE 插帧: 浏览器无 WebGPU，直接使用 CPU');
    }
    if (!session) {
      const t1 = performance.now();
      session = await ort.InferenceSession.create(await FrameInterpolator.fetchModelData(), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      log('warn', `RIFE 插帧: 使用 CPU 推理（较慢，会话创建 ${Math.round(performance.now() - t1)}ms）`);
    }
    log('ai', `RIFE 引擎就绪: 后端=${ep}, 总耗时 ${Math.round(performance.now() - t0)}ms`);
    return new FrameInterpolator(session, ep);
  }

  /** 灰色恒等探针：WebGPU EP 对部分张量广播内核不支持，会话能创建但 run 时才失败，必须实跑验证 */
  private static async warmupCheck(session: ort.InferenceSession): Promise<boolean> {
    const S = 64;
    const px = S * S;
    const grey = new Float32Array(3 * px).fill(0.5);
    const grid = new Float32Array(2 * px);
    for (let y = 0; y < S; y++) {
      const yn = (y / (S - 1)) * 2 - 1;
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        grid[i] = (x / (S - 1)) * 2 - 1;
        grid[px + i] = yn;
      }
    }
    try {
      const out = await session.run({
        img0: new ort.Tensor('float32', grey, [1, 3, S, S]),
        img1: new ort.Tensor('float32', grey, [1, 3, S, S]),
        timestep: new ort.Tensor('float32', new Float32Array([0.5]), [1, 1, 1, 1]),
        tenFlow_div: new ort.Tensor('float32', new Float32Array([S, S]), [2]),
        backwarp_tenGrid: new ort.Tensor('float32', grid, [1, 2, S, S]),
      });
      const data = out['frame'].data as Float32Array;
      if (data.length !== 3 * px) return false;
      const step = Math.max(1, Math.floor(data.length / 64));
      for (let i = 0; i < data.length; i += step) {
        if (!Number.isFinite(data[i]) || Math.abs(data[i] - 0.5) > 0.1) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private getGrid(w: number, h: number): ort.Tensor {
    const key = `${w}x${h}`;
    let t = this.gridCache.get(key);
    if (!t) {
      const g = new Float32Array(2 * w * h);
      for (let y = 0; y < h; y++) {
        const yn = (y / (h - 1)) * 2 - 1;
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          g[i] = (x / (w - 1)) * 2 - 1;
          g[w * h + i] = yn;
        }
      }
      t = new ort.Tensor('float32', g, [1, 2, h, w]);
      this.gridCache.set(key, t);
    }
    return t;
  }

  async interpolate(
    rgba0: Uint8ClampedArray,
    rgba1: Uint8ClampedArray,
    w: number,
    h: number,
    t: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer>> {
    // RIFE 的 IfNet 有 5 级下采样，W/H 必须能被 32 整除，否则 ONNX 图内形状不匹配直接报错
    const pw = Math.ceil(w / 32) * 32;
    const ph = Math.ceil(h / 32) * 32;
    if ((pw !== w || ph !== h) && this.loggedPad !== `${w}x${h}`) {
      this.loggedPad = `${w}x${h}`;
      log('ai', `RIFE: 输入 ${w}x${h} 非 32 倍数 → padding 到 ${pw}x${ph} 推理后裁回`);
    }
    const ppx = pw * ph;
    const f0 = new Float32Array(3 * ppx);
    const f1 = new Float32Array(3 * ppx);
    // 边缘复制填充（大图时百万级同步循环，每 128 行让出，避免页面无响应）
    for (let y = 0; y < ph; y++) {
      if ((y & 127) === 0) await new Promise((r) => setTimeout(r, 0));
      const sy = Math.min(y, h - 1);
      for (let x = 0; x < pw; x++) {
        const sx = Math.min(x, w - 1);
        const si = (sy * w + sx) * 4;
        const di = y * pw + x;
        f0[di] = rgba0[si] / 255;
        f0[ppx + di] = rgba0[si + 1] / 255;
        f0[2 * ppx + di] = rgba0[si + 2] / 255;
        f1[di] = rgba1[si] / 255;
        f1[ppx + di] = rgba1[si + 1] / 255;
        f1[2 * ppx + di] = rgba1[si + 2] / 255;
      }
    }
    const feeds: Record<string, ort.Tensor> = {
      img0: new ort.Tensor('float32', f0, [1, 3, ph, pw]),
      img1: new ort.Tensor('float32', f1, [1, 3, ph, pw]),
      timestep: new ort.Tensor('float32', new Float32Array([t]), [1, 1, 1, 1]),
      tenFlow_div: new ort.Tensor('float32', new Float32Array([pw, ph]), [2]),
      backwarp_tenGrid: this.getGrid(pw, ph),
    };
    let data: Float32Array;
    try {
      const out = await this.session!.run(feeds);
      data = out['frame'].data as Float32Array;
    } catch (e) {
      // WebGPU EP 可能只在特定尺寸/算子上失败，一次性回退 CPU 后重试
      if (this.rebuiltOnCpu) throw e;
      this.rebuiltOnCpu = true;
      log('warn', `RIFE 推理失败，回退 CPU 重试: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      this.session?.release().catch(() => {});
      this.session = await ort.InferenceSession.create(await FrameInterpolator.fetchModelData(), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      const out = await this.session.run(feeds);
      data = out['frame'].data as Float32Array;
    }
    const ow = pw;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // 裁掉 padding，回到 w×h
    for (let y = 0; y < h; y++) {
      if ((y & 127) === 0) await new Promise((r) => setTimeout(r, 0));
      for (let x = 0; x < w; x++) {
        const si = y * ow + x;
        const di = (y * w + x) * 4;
        const r = data[si];
        const g = data[ppx + si];
        const b = data[2 * ppx + si];
        rgba[di] = r <= 0 ? 0 : r >= 1 ? 255 : r * 255;
        rgba[di + 1] = g <= 0 ? 0 : g >= 1 ? 255 : g * 255;
        rgba[di + 2] = b <= 0 ? 0 : b >= 1 ? 255 : b * 255;
        rgba[di + 3] = 255;
      }
    }
    return rgba;
  }

  destroy(): void {
    log('ai', `RIFE 会话已释放（后端=${this.ep}，缓存网格 ${this.gridCache.size} 个）`);
    this.gridCache.clear();
    this.session?.release().catch(() => {});
    this.session = null;
  }
}
