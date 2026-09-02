import {
  Input,
  Output,
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Mp4OutputFormat,
  VideoSampleSink,
  VideoSampleSource,
  AudioSampleSink,
  AudioSampleSource,
  VideoSample,
  Quality,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
  canEncodeVideo,
  type VideoCodec,
} from 'mediabunny';
import { FrameEnhancer, type ScaleFactor } from './gpu';
import { AiEngine } from './ai';
import { FrameInterpolator } from './interpolate';
import { AI_MODELS, getModel } from './models';
import { asciiConvert, getAsciiCharset, type AsciiJobOptions, type AsciiOptions } from './ascii';
import { log } from './logger';

export type { ScaleFactor };
export { AI_MODELS };

export interface EnhanceOptions {
  file: File;
  scale: ScaleFactor;
  sharpness: number;
  /** 'fsr' 或 AI 模型 id（见 models.ts） */
  engine?: string;
  /** AI 引擎时：推理后缩回原分辨率（画质修复，不放大） */
  aiKeepResolution?: boolean;
  /** AI 引擎时：半分辨率推理（计算量降 4 倍，画质略降） */
  aiHalfInput?: boolean;
  /** 插帧：'none' / 'x2' / 'x4'（RIFE 运动插帧） */
  interpolation?: 'none' | 'x2' | 'x4';
  /** 测试专用：允许全黑输出（headless 软渲染） */
  allowBlackFrames?: boolean;
  /** 硬件编码加速：请求显卡固定功能编码器，浏览器/驱动不支持时自动回退软件 */
  hwEncode?: boolean;
  /** 功能模式：画质增强（默认）或 ASCII 字符画转换 */
  mode?: 'enhance' | 'ascii';
  /** mode='ascii' 时的转换参数 */
  ascii?: AsciiJobOptions;
}

export interface ProgressInfo {
  phase: 'analyze' | 'model' | 'video' | 'done';
  modelStage?: 'fetch' | 'compile' | 'ready';
  modelLoaded?: number;
  modelTotal?: number;
  aiEp?: 'webgpu' | 'wasm';
  frameMs?: number;
  inferMs?: number;
  encodeMs?: number;
  processed: number;
  total: number;
  /** RIFE 插帧耗时（每源帧平均） */
  interpMs?: number;
}

export interface EnhanceResult {
  blob: Blob;
  width: number;
  height: number;
  processedFrames: number;
  elapsedMs: number;
}

function roundEven(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r - 1;
}

const CODEC_LABELS: Record<string, string> = {
  avc: 'H.264',
  hevc: 'HEVC (H.265)',
  vp9: 'VP9',
  av1: 'AV1',
  vp8: 'VP8',
};

export async function probeVideo(file: File): Promise<{ codec: string | null; codecString: string | null; decodable: boolean; width: number; height: number }> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('文件中没有视频轨。');
  const codec = await track.getCodec();
  const config = await track.getDecoderConfig().catch(() => null);
  return {
    codec,
    codecString: config?.codec ?? null,
    decodable: await track.canDecode(),
    width: track.displayWidth,
    height: track.displayHeight,
  };
}

export async function enhanceVideo(
  options: EnhanceOptions,
  onProgress: (info: ProgressInfo) => void,
  shouldCancel: () => boolean,
): Promise<EnhanceResult> {
  const start = performance.now();
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(options.file) });

  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error('文件中没有视频轨。');

  onProgress({ phase: 'analyze', processed: 0, total: 0 });

  const stats = await videoTrack.computePacketStats(100);
  const fps = stats.averagePacketRate > 0 ? stats.averagePacketRate : 30;
  const duration = await videoTrack.computeDuration();
  const totalFrames = Math.max(1, Math.round(duration * fps));


  const asciiOn = options.mode === 'ascii' && !!options.ascii;
  const asciiOpts: AsciiOptions | null = asciiOn
    ? {
        columns: options.ascii!.columns,
        charset: getAsciiCharset(options.ascii!.charsetId),
        color: options.ascii!.color,
        invert: options.ascii!.invert,
      }
    : null;
  const engine = !asciiOn && options.engine && options.engine !== 'fsr' ? options.engine : null;
  log(
    'info',
    `引擎: ${asciiOn ? 'ASCII 字符画转换' : engine ?? '算法增强 (CAS/FSR)'}` +
      `${asciiOn ? '' : `, 锐度 ${(options.sharpness * 100) | 0}%`}`,
  );
  if (asciiOn && options.ascii) {
    log(
      'info',
      `ASCII 参数: ${options.ascii.columns} 列, 字符集 ${options.ascii.charsetId}` +
        `, ${options.ascii.color ? '彩色' : '单色'}${options.ascii.invert ? ', 反相(白底黑字)' : ''}`,
    );
  }
  const aiScale = engine ? getModel(engine).scale : null;
  const keepRes = !!engine && !!options.aiKeepResolution;
  const effScale = (asciiOn ? 1 : keepRes ? 1 : aiScale ?? options.scale) as number;

  const inW = videoTrack.displayWidth;
  const inH = videoTrack.displayHeight;
  const srcCodec = await videoTrack.getCodec().catch(() => null);
  log('info', `视频: ${inW}x${inH} @ ${fps.toFixed(2)}fps, ${duration.toFixed(1)}s, ${totalFrames} 帧, 编码 ${srcCodec ?? '?'}`);
  const outW = roundEven(inW * effScale);
  const outH = roundEven(inH * effScale);
  if (keepRes) {
    log('info', `AI 修复模式：模型内部 ${aiScale}x 推理后缩回原分辨率 ${outW}x${outH}`);
  }

  if (outW > 7680 || outH > 4320) {
    throw new Error(`输出分辨率 ${outW}×${outH} 过大，超出限制 (7680×4320)。`);
  }

  // 硬件编码探测：Chrome 对 prefer-hardware 是硬性要求（无硬件编码器时 configure 直接抛错），
  // 必须先逐候选探测，不可用再走软件路径
  let codec: VideoCodec | null = null;
  let hwActive = false;
  if (options.hwEncode !== false) {
    for (const c of ['avc', 'vp9', 'av1'] as const) {
      if (
        await canEncodeVideo(c, {
          width: outW,
          height: outH,
          hardwareAcceleration: 'prefer-hardware',
        })
      ) {
        codec = c;
        hwActive = true;
        break;
      }
    }
    log(
      'info',
      hwActive
        ? `硬件编码可用（${codec}），将使用显卡固定功能编码器`
        : '硬件编码不可用（无可用编码器或驱动限制），回退软件编码',
    );
  }
  let codecFallback = false;
  if (!codec) {
    codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], {
      width: outW,
      height: outH,
    });
    if (!codec) {
      codec = 'avc';
      codecFallback = true;
    }
  }

  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
  });

  const interpFactor = asciiOn ? 0 : options.interpolation === 'x4' ? 4 : options.interpolation === 'x2' ? 2 : 0;
  const interpOn = interpFactor > 0;
  const outFps = interpOn ? fps * interpFactor : fps;
  const bitrate = Math.min(100e6, Math.max(2e6, Math.round(outW * outH * outFps * 0.12)));
  log(
    'info',
    `输出: ${outW}x${outH} @ ${outFps.toFixed(1)}fps, 编码 ${codec}${hwActive ? '（硬件）' : '（软件）'}` +
      `, 码率 ${(bitrate / 1e6).toFixed(1)}Mbps`,
  );
  const videoSource = new VideoSampleSource({
    codec,
    quality: new Quality({ bitrate }),
    latencyMode: 'quality',
    hardwareAcceleration: hwActive ? 'prefer-hardware' : 'no-preference',
  });
  output.addVideoTrack(videoSource, { frameRate: outFps });

  let audioSource: AudioSampleSource | null = null;
  const audioTrack = await input.getPrimaryAudioTrack();
  if (audioTrack && (await audioTrack.canDecode())) {
    const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus']);
    if (audioCodec) {
      audioSource = new AudioSampleSource({
        codec: audioCodec,
        quality: new Quality('medium'),
      });
      try {
        output.addAudioTrack(audioSource);
      } catch {
        audioSource = null;
      }
    }
  }

  await output.start();

  if (audioSource && audioTrack) {
    const aBase = await audioTrack.getFirstTimestamp();
    const audioSink = new AudioSampleSink(audioTrack);
    for await (const sample of audioSink.samples()) {
      if (shouldCancel()) break;
      sample.setTimestamp(sample.timestamp - aBase);
      if (sample.timestamp < 0) {
        sample.close();
        continue;
      }
      await audioSource.add(sample);
      sample.close();
    }
    audioSource.close();
  }

  if (shouldCancel()) {
    await output.cancel();
    throw new Error('已取消。');
  }

  let ai: AiEngine | null = null;
  if (engine) {
    ai = await AiEngine.load(engine, (modelStage, modelLoaded, modelTotal) => {
      onProgress({ phase: 'model', modelStage, modelLoaded, modelTotal, processed: 0, total: totalFrames });
    });
  }
  const enhancer = engine || asciiOn ? null : await FrameEnhancer.create();
  const aiEp = ai?.ep;
  const sink = new VideoSampleSink(videoTrack);
  const dw = videoTrack.displayWidth;
  const dh = videoTrack.displayHeight;
  const stageCanvas = new OffscreenCanvas(dw, dh);
  const stageCtx = stageCanvas.getContext('2d')!;

  const vBase = await videoTrack.getFirstTimestamp();
  const inter = interpOn ? await FrameInterpolator.load() : null;
  const frameDur = 1 / outFps;
  if (inter) {
    log(
      'info',
      `RIFE 插帧 x${interpFactor}: 在源分辨率 ${dw}x${dh} 上每对相邻帧插 ${interpFactor - 1} 帧 → 输出 ${outFps.toFixed(0)}fps`,
    );
  }
  let emitted = 0;
  let prevSrcRgba: Uint8ClampedArray | null = null;
  let prevEnhanced: OffscreenCanvas | null = null;
  let processed = 0;
  let frameMs = 0;
  let lastFrameAt = 0;
  let inferMs = 0;
  let interpMs = 0;
  let encodeMs = 0;
  let capped4kLogged = false;
  let stage: 'video-decode' | 'video-encode' = 'video-decode';

  const ema = (old: number, v: number) => (old === 0 ? v : old * 0.8 + v * 0.2);

  const runEnhance = async (src: OffscreenCanvas): Promise<OffscreenCanvas> => {
    if (asciiOpts) return asciiConvert(src, asciiOpts);
    if (ai) {
      return ai.processCanvas(src, { halfInput: options.aiHalfInput, keepResolution: options.aiKeepResolution });
    }
    return enhancer!.processFrame(src, {
      scale: options.scale,
      sharpness: options.sharpness,
      allowBlackFrames: options.allowBlackFrames,
    });
  };

  // keepRes 缩回源分辨率与 4K 上限对普通/插帧两条路径统一生效
  const finalizeFrame = (canvas: OffscreenCanvas): OffscreenCanvas => {
    let out = canvas;
    if (ai && keepRes && (out.width !== dw || out.height !== dh)) {
      const back = new OffscreenCanvas(dw, dh);
      back.getContext('2d')!.drawImage(out, 0, 0, dw, dh);
      out = back;
    }
    if (out.width * out.height > 3840 * 2160) {
      const k = Math.min(3840 / out.width, 2160 / out.height);
      const cw = roundEven(out.width * k);
      const ch = roundEven(out.height * k);
      const scaled = new OffscreenCanvas(cw, ch);
      scaled.getContext('2d')!.drawImage(out, 0, 0, cw, ch);
      out = scaled;
      if (!capped4kLogged) {
        capped4kLogged = true;
        log('info', `输出超过 4K，已限制到 ${cw}x${ch}`);
      }
    }
    return out;
  };

  const encodeOut = async (canvas: OffscreenCanvas, timestamp: number, duration: number) => {
    const out = new VideoSample(canvas, { timestamp, duration });
    stage = 'video-encode';
    try {
      await videoSource.add(out);
    } finally {
      stage = 'video-decode';
    }
    out.close();
  };

  try {
    for await (const sample of sink.samples()) {
      if (shouldCancel()) {
        await output.cancel();
        throw new Error('已取消。');
      }
      const srcTs = Math.max(0, sample.timestamp - vBase);
      const srcDur = sample.duration > 0 ? sample.duration : 1 / fps;
      stageCtx.clearRect(0, 0, dw, dh);
      sample.draw(stageCtx, 0, 0, dw, dh);
      sample.close();
      processed++;
      const now = performance.now();
      if (lastFrameAt > 0) frameMs = frameMs * 0.8 + (now - lastFrameAt) * 0.2;
      lastFrameAt = now;

      let itInfer = 0;
      let itInterp = 0;
      let itEncode = 0;

      if (inter) {
        // 插帧在源分辨率上进行（RIFE 计算量随分辨率平方增长，放大后插值代价 ×scale²），
        // 每个出片帧（含插出的中间帧）再单独做增强
        const curRgba = stageCtx.getImageData(0, 0, dw, dh).data;
        if (!prevSrcRgba || !prevEnhanced) {
          let t = performance.now();
          const enhanced = await runEnhance(stageCanvas);
          itInfer += performance.now() - t;
          prevEnhanced = finalizeFrame(enhanced);
          t = performance.now();
          await encodeOut(prevEnhanced, emitted * frameDur, frameDur);
          itEncode += performance.now() - t;
          emitted += 1;
        } else {
          // 上一源帧的增强结果已在上一轮缓存，直接出片（首帧由此出现两次，使总时长与源一致）
          let t = performance.now();
          await encodeOut(prevEnhanced, emitted * frameDur, frameDur);
          itEncode += performance.now() - t;
          for (let k = 1; k < interpFactor; k++) {
            const t0i = performance.now();
            const mid = await inter.interpolate(prevSrcRgba, curRgba, dw, dh, k / interpFactor);
            itInterp += performance.now() - t0i;
            const midCanvas = new OffscreenCanvas(dw, dh);
            midCanvas.getContext('2d')!.putImageData(new ImageData(mid, dw, dh), 0, 0);
            t = performance.now();
            const enhanced = await runEnhance(midCanvas);
            itInfer += performance.now() - t;
            t = performance.now();
            await encodeOut(finalizeFrame(enhanced), (emitted + k) * frameDur, frameDur);
            itEncode += performance.now() - t;
          }
          // 当前源帧增强后缓存，作为下一轮的第一个出片帧
          t = performance.now();
          const enhanced = await runEnhance(stageCanvas);
          itInfer += performance.now() - t;
          prevEnhanced = finalizeFrame(enhanced);
          emitted += interpFactor;
        }
        prevSrcRgba = curRgba;
      } else {
        const t0 = performance.now();
        const canvas = await runEnhance(stageCanvas);
        const t1 = performance.now();
        const finalC = finalizeFrame(canvas);
        await encodeOut(finalC, srcTs, srcDur);
        itInfer += t1 - t0;
        itEncode += performance.now() - t1;
      }

      inferMs = ema(inferMs, itInfer);
      interpMs = ema(interpMs, itInterp);
      encodeMs = ema(encodeMs, itEncode);
      if (processed % 10 === 0) {
        const remain = ((totalFrames - processed) * frameMs) / 1000;
        const remainStr = remain >= 90 ? `${(remain / 60).toFixed(1)}min` : `${remain.toFixed(0)}s`;
        log(
          'info',
          `源帧 ${processed}/${totalFrames} → 已出片 ${emitted} 帧 | 均 ${frameMs.toFixed(2)}s/源帧` +
            ` = 推理 ${(inferMs / 1000).toFixed(2)} + 插帧 ${(interpMs / 1000).toFixed(2)}` +
            ` + 编码 ${(encodeMs / 1000).toFixed(2)} | 后端 ${aiEp === 'wasm' ? 'CPU' : 'GPU'}` +
            ` | 预计剩余 ${remainStr}`,
        );
      }
      onProgress({ phase: 'video', processed, total: totalFrames, aiEp, frameMs, inferMs, interpMs, encodeMs });
    }
    if (inter && prevEnhanced) {
      await encodeOut(prevEnhanced, emitted * frameDur, frameDur);
    }
  } catch (err) {
    if (err instanceof Error && err.message === '已取消。') throw err;
    // stage 在 encodeOut 闭包内赋值，TS 流分析不追踪，需放宽为 string 再比较
    const stageAtError: string = stage;
    if (stageAtError === 'video-encode') {
      throw new Error(
        `视频编码失败（目标 ${outW}×${outH}，编码 ${codec}${codecFallback ? '，由回退策略选定' : ''}）。` +
          `可尝试换浏览器，或降低输出分辨率。`,
        { cause: err },
      );
    }
    const srcCodec = await videoTrack.getCodec().catch(() => null);
    const config = await videoTrack.getDecoderConfig().catch(() => null);
    const label = srcCodec ? (CODEC_LABELS[srcCodec] ?? srcCodec) : '未知编码';
    const detail = config?.codec ? ` (${config.codec})` : '';
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `视频解码失败：${label}${detail}。原始错误：${cause}` +
        `。可先转码：ffmpeg -i 输入.mp4 -c:v libx264 -crf 18 -pix_fmt yuv420p 输出.mp4`,
      { cause: err },
    );
  } finally {
    videoSource.close();
    enhancer?.destroy();
    ai?.destroy();
    inter?.destroy();
  }

  await output.finalize();
  const buffer = output.target.buffer;
  if (!buffer) throw new Error('输出缓冲为空。');

  onProgress({ phase: 'done', processed, total: totalFrames });

  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    width: outW,
    height: outH,
    processedFrames: processed,
    elapsedMs: performance.now() - start,
  };
}
