import * as ort from 'onnxruntime-web';
import { AI_MODELS, getModel, type ModelInfo } from './models';
import { log } from './logger';
import ortMjs from './ort-assets/ort-wasm-simd-threaded.jsep.mjs?url';
import ortWasm from './ort-assets/ort-wasm-simd-threaded.jsep.wasm?url';

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };

export type AiProgress = (stage: 'fetch' | 'compile' | 'ready', loaded?: number, total?: number) => void;

/** 删除过期模型缓存：键不在当前版本集合里的 /models/* 一律清掉（含已下线模型的 27MB 旧权重） */
async function purgeStaleModelCaches(cache: Cache): Promise<void> {
  try {
    const keep = new Set<string>();
    for (const m of AI_MODELS) {
      for (const f of [m.file, `${m.file}.fp16`]) {
        // rev>1 的模型只认带参键，不带参旧键视为过期删掉
        keep.add(m.rev > 1 ? `${f}?r=${m.rev}` : f);
      }
    }
    keep.add('/models/rife422-lite.onnx');
    let dropped = 0;
    for (const req of await cache.keys()) {
      const u = new URL(req.url);
      if (!u.pathname.startsWith('/models/')) continue;
      const key = u.pathname + u.search;
      if (!keep.has(key) && !keep.has(u.pathname)) {
        await cache.delete(req);
        dropped++;
      }
    }
    if (dropped > 0) log('ai', `已清理过期模型缓存 ${dropped} 项`);
  } catch {
    /* 清理失败不影响主流程 */
  }
}

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
  private tile = 768;
  private halfLogged = false;
  private tileLogged = false;
  private splitLogged = false;
  private capLogged = false;
  private _ep: 'webgpu' | 'wasm' = 'wasm';

  private constructor(session: ort.InferenceSession, model: ModelInfo, ep: 'webgpu' | 'wasm') {
    this.session = session;
    this.model = model;
    this.tile = model.tile ?? 768;
    this._ep = ep;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
  }

  get ep(): 'webgpu' | 'wasm' {
    return this._ep;
  }

  static async load(
    modelId: string,
    onProgress: AiProgress,
    opts?: { forceWasm?: boolean },
  ): Promise<AiEngine> {
    const model = getModel(modelId);
    const t0 = performance.now();
    // 线程数必须在会话创建前设定，创建后再改对已建会话无效
    const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    ort.env.wasm.numThreads = isolated
      ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1))
      : 1;
    log('ai', `引擎加载: ${model.name} (${model.sizeMB}MB, ${model.scale}x, 输入范围 0-${model.inputRange})`);
    log('ai', `运行环境: crossOriginIsolated=${isolated}, 硬件并发=${navigator.hardwareConcurrency ?? '?'}, wasm 线程=${ort.env.wasm.numThreads}`);
    onProgress('fetch', 0, 1);

    const fetchModel = async (file: string): Promise<Uint8Array> => {
      // 缓存键带 rev：权重更新后旧缓存自动失效（硬刷新清不掉 CacheStorage，必须靠键变更）
      const url = model.rev > 1 ? `${file}?r=${model.rev}` : file;
      const t = performance.now();
      try {
        const cache = await caches.open('ai-models');
        await purgeStaleModelCaches(cache);
        let resp = await cache.match(url);
        if (!resp) {
          log('ai', `模型未命中缓存，开始下载: ${url}`);
          const fetched = await fetch(url);
          if (!fetched.ok) throw new Error(`模型下载失败 HTTP ${fetched.status}`);
          await cache.put(url, fetched.clone());
          resp = await cache.match(url);
        } else {
          log('ai', `模型命中本地缓存: ${url}`);
        }
        const data = new Uint8Array(await (resp as Response).arrayBuffer());
        log('ai', `模型就绪: ${url} (${(data.byteLength / 1048576).toFixed(1)}MB, ${Math.round(performance.now() - t)}ms)`);
        return data;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('模型下载失败')) throw e;
        log('warn', `CacheStorage 不可用，直连下载: ${url}`);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`模型下载失败 HTTP ${resp.status}`);
        const data = new Uint8Array(await resp.arrayBuffer());
        log('ai', `模型就绪: ${url} (${(data.byteLength / 1048576).toFixed(1)}MB, ${Math.round(performance.now() - t)}ms)`);
        return data;
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
    if (opts?.forceWasm) {
      log('ai', '测试模式：强制 wasm 推理，跳过 WebGPU');
    } else if (navigator.gpu) {
      try {
        const ad = await navigator.gpu.requestAdapter();
        if (!ad) throw new Error('requestAdapter 返回空');
        const hasF16 = ad.features.has('shader-f16');
        log('gpu', `AI 引擎探测: ${ad.info?.description || ad.info?.vendor || '适配器'}, shader-f16=${hasF16}`);
        // 部分 Intel 驱动 fp16 会话能创建但输出全零：fp16 失败后必须先试 fp32 WebGPU，最后才回 CPU
        const candidates: { file: string; label: string }[] = hasF16
          ? [
              { file: model.file + '.fp16', label: 'fp16' },
              { file: model.file, label: 'fp32' },
            ]
          : [{ file: model.file, label: 'fp32' }];
        for (const cand of candidates) {
          try {
            log('ai', `尝试 WebGPU 推理（${cand.label} 模型）…`);
            session = await create(await fetchModel(cand.file), ['webgpu']);
            ep = 'webgpu';
            log('gpu', `WebGPU 会话创建成功（${cand.label}）`);
            // 三档 warmup：48px 验基本正确性，192px 验中等尺寸，
            // 满块尺寸（model.tile）验真实推理 regime。
            // 某 Intel 驱动上 CUGAN 的 48/192 全过、752 首块确定性全零，
            // 必须在加载期用满块拦住，否则任务中途抛错。
            const sizes = [48, 192, model.tile ?? 768];
            let failed = '';
            for (const s of sizes) {
              const chk = await AiEngine.warmupCheck(
                session,
                session.inputNames[0],
                session.outputNames[0],
                model.inputRange,
                s,
              );
              log(chk.ok ? 'gpu' : 'warn', `warmup ${s}px：${chk.ok ? '通过' : '未通过'}（${chk.detail}）`);
              if (!chk.ok) {
                failed = `${s}px ${chk.detail}`;
                break;
              }
            }
            if (failed) {
              const last = cand.label === 'fp32' ? '回退 CPU 推理' : '尝试 fp32 WebGPU';
              log('warn', `WebGPU ${cand.label} warmup 自检未通过（${failed}）→ ${last}`);
              await session.release();
              session = null;
              ep = 'wasm';
              continue;
            }
            log('gpu', 'warmup 三档（48/192/满块）全通过，GPU 推理可用');
            break;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log('warn', `WebGPU ${cand.label} 初始化失败: ${msg.slice(0, 180)}`);
            session = null;
            ep = 'wasm';
          }
        }
      } catch (e) {
        webgpuErr = e instanceof Error ? e.message : String(e);
        log('warn', `WebGPU EP 初始化失败: ${webgpuErr.slice(0, 180)}`);
      }
    } else if (!opts?.forceWasm) {
      webgpuErr = '浏览器无 WebGPU';
      log('warn', '浏览器无 WebGPU，将使用 CPU 推理');
    }
    if (!session) {
      log('ai', `加载 fp32 模型（CPU 推理）…`);
      const t1 = performance.now();
      session = await create(await fetchModel(model.file), ['wasm']);
      ep = 'wasm';
      log('ai', `CPU 会话创建耗时 ${Math.round(performance.now() - t1)}ms`);
    }
    if (ep === 'wasm') {
      log('warn', `最终推理后端: CPU (wasm, ${ort.env.wasm.numThreads} 线程)。速度比 GPU 慢 10 倍以上。`);
    } else {
      log('gpu', `最终推理后端: GPU (WebGPU)`);
    }
    log('ai', `引擎就绪: ${model.id}, 后端=${ep}, 总耗时 ${Math.round(performance.now() - t0)}ms`);
    onProgress('ready');
    return new AiEngine(session, model, ep);
  }

  static async warmupCheck(
    session: ort.InferenceSession,
    inputName: string,
    outputName: string,
    inputRange: number,
    S = 48,
  ): Promise<{ ok: boolean; detail: string }> {
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
      let failed = '';
      const samples = [8, 24, 40];
      for (const sy of samples) {
        for (const sx of samples) {
          const i = sy * ow + sx;
          const r = data[i];
          const g = data[stride + i];
          const b = data[stride * 2 + i];
          // NaN 参与任何比较都为 false，会静默通过下面的阈值检查，必须显式排除
          if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
            ok = false;
            if (!failed) failed = `(${sx},${sy}) rgb=${r},${g},${b} 含非有限值`;
            continue;
          }
          const mean = (r + g + b) / 3;
          const spread = Math.max(Math.abs(r - mean), Math.abs(g - mean), Math.abs(b - mean));
          if (spread > inputRange * 0.08 || Math.abs(mean - grey) > inputRange * 0.2) {
            ok = false;
            if (!failed) failed = `(${sx},${sy}) rgb=${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)} (期望≈${grey})`;
          }
        }
      }
      // detail 带输出 dims 与首个异常采样点：fp16 在部分驱动上全零/NaN 就靠这行定位
      return { ok, detail: `out=${dims.join('x')}${ok ? '' : `, ${failed}`}` };
    } catch (e) {
      return { ok: false, detail: `run 抛错: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}` };
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
      // 逐帧打会刷屏（500 条上限），只记一次
      if (!this.halfLogged) {
        this.halfLogged = true;
        log('ai', `性能模式: 推理输入 ${work.width}x${work.height} (源 ${src.width}x${src.height})，后续帧不再重复记录`);
      }
    }
    const scale = this.model.scale;
    let w = work.width;
    let h = work.height;
    // 限幅前置：模型输出超 4K 上限时，最终都会被缩回 4K（见 finalize），
    // 全分辨率推理的中间缓冲（千万像素级 Float32 x3 + RGBA）在低显存机器上直接 OOM 卡死。
    // 先等比缩输入，使模型输出≈上限：计算量/内存同比例下降，视觉等价（多余像素本就要扔掉）。
    const CAP_PX = 3840 * 2160;
    if (w * h * scale * scale > CAP_PX) {
      const k = Math.sqrt(CAP_PX / (w * h * scale * scale));
      const cw = Math.max(64, Math.round(w * k));
      const ch = Math.max(64, Math.round(h * k));
      const pre = new OffscreenCanvas(cw, ch);
      pre.getContext('2d')!.drawImage(work, 0, 0, cw, ch);
      work = pre;
      w = cw;
      h = ch;
      if (!this.capLogged) {
        this.capLogged = true;
        log('ai', `限幅前置: 模型输出超 4K，输入先缩到 ${cw}x${ch}（输出≈${cw * scale}x${ch * scale}），后续帧不再重复记录`);
      }
    }
    const ctx = work.getContext('2d')!;
    const img = ctx.getImageData(0, 0, w, h);

    const useTile = w > this.tile || h > this.tile;
    if (useTile && !this.tileLogged) {
      this.tileLogged = true;
      log('ai', `分块推理: 输入 ${w}x${h} 超过单块 ${this.tile}px，按 ${this.tile}px 分块（重叠 16px）逐块推理后加权拼接，后续帧不再重复记录`);
    }
    // 瓦片按模型倍数拼装，keepResolution 最后统一缩回源尺寸
    const upW = w * scale;
    const upH = h * scale;
    const targetW = runOpts?.keepResolution ? src.width : upW;
    const targetH = runOpts?.keepResolution ? src.height : upH;

    if (!useTile) {
      let t = performance.now();
      const out = await this.inferTensor(img.data, w, h, `整图${w}x${h}`);
      const tRun = performance.now() - t;
      t = performance.now();
      const rgba = await this.chwToRgba(out.data, out.w, out.h);
      const outCanvas = new OffscreenCanvas(targetW, targetH);
      const octx = outCanvas.getContext('2d')!;
      if (out.w === targetW && out.h === targetH) {
        octx.putImageData(new ImageData(rgba, out.w, out.h), 0, 0);
      } else {
        const tmp = new OffscreenCanvas(out.w, out.h);
        tmp.getContext('2d')!.putImageData(new ImageData(rgba, out.w, out.h), 0, 0);
        octx.imageSmoothingEnabled = true;
        octx.drawImage(tmp, 0, 0, targetW, targetH);
      }
      if (!this.splitLogged) {
        this.splitLogged = true;
        log('ai', `首帧耗时拆分: 会话推理 ${Math.round(tRun)}ms + JS 拼装 ${Math.round(performance.now() - t)}ms`);
      }
      return outCanvas;
    }

    const sum = new Float32Array(upW * upH * 3);
    const wsum = new Float32Array(upW * upH);

    const ov = 16;
    const tileScale = this.model.scale;
    let tRun = 0;
    let tBlend = 0;
    let nTiles = 0;
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
        let t = performance.now();
        const outTile = await this.inferTensor(patch, tw, th, `块(${sx},${sy})${tw}x${th}`);
        tRun += performance.now() - t;
        nTiles++;

        t = performance.now();
        const tileRgba = await this.chwToRgba(outTile.data, outTile.w, outTile.h);
        await blitBlend(
          tileRgba,
          outTile.w,
          outTile.h,
          sum,
          wsum,
          upW,
          0,
          0,
          outTile.w,
          outTile.h,
          sx * tileScale,
          sy * tileScale,
          sx * tileScale,
          (sx + tw) * tileScale,
          sy * tileScale,
          (sy + th) * tileScale,
          ov * tileScale,
        );
        tBlend += performance.now() - t;
      }
    }
    let tAsm = performance.now();
    const assembled = new OffscreenCanvas(upW, upH);
    const finalRgba = new Uint8ClampedArray(upW * upH * 4);
    const totalPx = upW * upH;
    for (let i = 0; i < totalPx; i++) {
      // 每 1M 像素让出一次：9M 级归一化循环同样是秒级同步块
      if ((i & 0xfffff) === 0) await yieldToUI();
      const w = wsum[i];
      finalRgba[i * 4] = w > 0 ? sum[i * 3] / w : 0;
      finalRgba[i * 4 + 1] = w > 0 ? sum[i * 3 + 1] / w : 0;
      finalRgba[i * 4 + 2] = w > 0 ? sum[i * 3 + 2] / w : 0;
      finalRgba[i * 4 + 3] = 255;
    }
    if (import.meta.env.DEV) {
      let zeros = 0;
      let firstZero: number[] | null = null;
      for (let yy = 0; yy < upH; yy += 3) {
        for (let xx = 0; xx < upW; xx += 7) {
          if (wsum[yy * upW + xx] === 0) {
            zeros++;
            if (!firstZero) firstZero = [xx, yy];
          }
        }
      }
      if (zeros > 0) console.log('[dbg] wsum==0 count:', zeros, 'first:', firstZero, 'target:', upW, upH);
    }
    assembled.getContext('2d')!.putImageData(new ImageData(finalRgba, upW, upH), 0, 0);
    tBlend += performance.now() - tAsm;
    if (!this.splitLogged) {
      this.splitLogged = true;
      log('ai', `首帧耗时拆分: 会话推理 ${Math.round(tRun)}ms + JS 拼装 ${Math.round(tBlend)}ms (${nTiles} 块 ${w}x${h}→${upW}x${upH})`);
    }
    if (upW === targetW && upH === targetH) {
      return assembled;
    }
    const outCanvas = new OffscreenCanvas(targetW, targetH);
    const octx = outCanvas.getContext('2d')!;
    octx.imageSmoothingEnabled = true;
    octx.drawImage(assembled, 0, 0, targetW, targetH);
    return outCanvas;
  }

  private async inferTensor(
    rgba: Uint8ClampedArray,
    w: number,
    h: number,
    where = '整图',
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
    // 坏块自检：部分驱动 WebGPU 下首块会静默返回全零/NaN（48px warmup 测不出尺寸相关问题），
    // 必须按块验输出。输入全黑导致输出全零是合法的，只有"输入非空+输出异常"才判坏。
    for (let attempt = 0; attempt < 2; attempt++) {
      const results = await this.session!.run(feeds);
      const t = results[this.outputName];
      const data = t.data as Float32Array;
      const bad = findBadOutput(rgba, data, this.model.inputRange);
      if (!bad) return { data, w: t.dims[3], h: t.dims[2] };
      log('warn', `AI 推理输出异常（${where} ${w}x${h}，后端=${this._ep}，第 ${attempt + 1} 次：${bad}），重试`);
    }
    throw new Error(
      `AI 推理输出异常（${where} ${w}x${h}，后端=${this._ep}）：输入非空但连续两次输出全零/非法值。` +
        `可能是显卡驱动 WebGPU 实现问题，可换“算法增强”引擎，或把日志贴给开发者。`,
    );
  }

  private async chwToRgba(data: Float32Array, w: number, h: number): Promise<Uint8ClampedArray<ArrayBuffer>> {
    const range = this.model.inputRange;
    const px = w * h;
    const rgba = new Uint8ClampedArray(px * 4);
    // 逐像素 JS 循环：4x 大图时单次同步执行可达秒级，每 1M 像素让出一次，避免主线程被判无响应
    for (let i = 0; i < px; i++) {
      if ((i & 0xfffff) === 0) await yieldToUI();
      rgba[i * 4] = toByte(data[i], range);
      rgba[i * 4 + 1] = toByte(data[px + i], range);
      rgba[i * 4 + 2] = toByte(data[px * 2 + i], range);
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }

  destroy(): void {
    log('ai', `AI 引擎已释放: ${this.model.id} (后端=${this._ep})`);
    this.session?.release().catch(() => {});
    this.session = null;
  }
}

function toByte(v: number, range: number): number {
  if (v <= 0) return 0;
  if (v >= range) return 255;
  return (v / range) * 255;
}

/** 抽样验推理输出：返回异常描述，无异常返回 null。采样约 2000 点，开销可忽略。 */
function findBadOutput(
  rgba: Uint8ClampedArray,
  data: Float32Array,
  inputRange: number,
): string | null {
  const px = rgba.length / 4;
  const step = Math.max(1, Math.floor(px / 700));
  let inMax = 0;
  for (let i = 0; i < px; i += step) {
    const m = Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    if (m > inMax) inMax = m;
  }
  if (inMax <= 8) return null; // 输入近乎全黑，输出全零合法，不判
  const opx = data.length / 3;
  const ostep = Math.max(1, Math.floor(opx / 700));
  let outMax = 0;
  for (let c = 0; c < 3; c++) {
    const base = c * opx;
    for (let i = 0; i < opx; i += ostep) {
      const v = data[base + i];
      if (!Number.isFinite(v)) return `输出含非有限值（通道 ${c}）`;
      const a = Math.abs(v);
      if (a > outMax) outMax = a;
    }
  }
  if (outMax < inputRange * 1e-6) return `输入最亮 ${inMax} 但输出全零`;
  if (outMax > inputRange * 100) return `输出爆炸（最大 ${outMax.toExponential(1)}）`;
  return null;
}

/** 让出主线程一个宏任务：CPU 回退时长循环是纯 JS 计算，不让出会被浏览器判“页面无响应” */
function yieldToUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function blitBlend(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  sum: Float32Array,
  wsum: Float32Array,
  dW: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  dx: number,
  dy: number,
  tileL: number,
  tileR: number,
  tileT: number,
  tileB: number,
  feather: number,
): Promise<void> {
  const xRatio = sw / rw;
  const yRatio = sh / rh;
  const effF = feather > 0 ? feather : 1;
  for (let y = 0; y < rh; y++) {
    // 每 128 行让出一次：9M 像素级全图混合是秒级同步块，不分片即卡死
    if ((y & 127) === 0) await yieldToUI();
    const py = dy + y;
    const fy = ry + (y + 0.5) * yRatio - 0.5;
    let y0 = Math.floor(fy);
    const wy = fy - y0;
    if (y0 < 0) y0 = 0;
    if (y0 >= sh) y0 = sh - 1;
    let y1 = y0 + 1;
    if (y1 >= sh) y1 = sh - 1;
    const rowA = y0 * sw;
    const rowB = y1 * sw;

    let wyEdge = 1;
    if (feather > 0) {
      const dTop = py - tileT;
      const dB = tileB - py;
      wyEdge = Math.max(0, Math.min(1, Math.min(dTop, dB) / effF));
      if (tileT <= 0 && dTop <= effF) wyEdge = 1;
      if (dB <= effF) wyEdge = 1;
    }

    for (let x = 0; x < rw; x++) {
      const px = dx + x;
      const fx = rx + (x + 0.5) * xRatio - 0.5;
      let x0 = Math.floor(fx);
      const wx = fx - x0;
      if (x0 < 0) x0 = 0;
      if (x0 >= sw) x0 = sw - 1;
      let x1 = x0 + 1;
      if (x1 >= sw) x1 = sw - 1;

      let w = wyEdge;
      if (feather > 0) {
        const dL = px - tileL;
        const dR = tileR - px;
        let wxEdge = Math.max(0, Math.min(1, Math.min(dL, dR) / effF));
        if (tileL <= 0 && dL <= effF) wxEdge = 1;
        if (dR <= effF) wxEdge = 1;
        w = wxEdge * wyEdge;
      }

      const i00 = (rowA + x0) * 4;
      const i10 = (rowA + x1) * 4;
      const i01 = (rowB + x0) * 4;
      const i11 = (rowB + x1) * 4;
      const w00 = (1 - wx) * (1 - wy);
      const w10 = wx * (1 - wy);
      const w01 = (1 - wx) * wy;
      const w11 = wx * wy;

      const di = (py * dW + px) * 3;
      const acc = w;
      sum[di] += (src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11) * acc;
      sum[di + 1] += (src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11) * acc;
      sum[di + 2] += (src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11) * acc;
      wsum[py * dW + px] += acc;
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
