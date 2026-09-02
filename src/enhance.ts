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
} from 'mediabunny';
import { FrameEnhancer, type ScaleFactor } from './gpu';
import { AiEngine } from './ai';
import { FrameInterpolator } from './interpolate';
import { AI_MODELS, getModel } from './models';
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


  const engine = options.engine && options.engine !== 'fsr' ? options.engine : null;
  log('info', `引擎: ${engine ?? '算法增强 (CAS/FSR)'}, 锐度 ${(options.sharpness * 100) | 0}%`);
  const aiScale = engine ? getModel(engine).scale : null;
  const keepRes = !!engine && !!options.aiKeepResolution;
  const effScale = (keepRes ? 1 : aiScale ?? options.scale) as number;

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

  let codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], {
    width: outW,
    height: outH,
  });
  let codecFallback = false;
  if (!codec) {
    codec = 'avc';
    codecFallback = true;
  }

  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
  });

  const interpFactor = options.interpolation === 'x4' ? 4 : options.interpolation === 'x2' ? 2 : 0;
  const interpOn = interpFactor > 0;
  const outFps = interpOn ? fps * interpFactor : fps;
  const bitrate = Math.min(100e6, Math.max(2e6, Math.round(outW * outH * outFps * 0.12)));
  log('info', `输出: ${outW}x${outH} @ ${outFps.toFixed(1)}fps, 编码 ${codec}, 码率 ${(bitrate / 1e6).toFixed(1)}Mbps`);
  const videoSource = new VideoSampleSource({
    codec,
    quality: new Quality({ bitrate }),
    latencyMode: 'quality',
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
  const enhancer = engine ? null : await FrameEnhancer.create();
  const aiEp = ai?.ep;
  const sink = new VideoSampleSink(videoTrack);
  const dw = videoTrack.displayWidth;
  const dh = videoTrack.displayHeight;
  const stageCanvas = new OffscreenCanvas(dw, dh);
  const stageCtx = stageCanvas.getContext('2d')!;

  const vBase = await videoTrack.getFirstTimestamp();
  const inter = interpOn ? await FrameInterpolator.load() : null;
  const frameDur = 1 / outFps;
  let emitted = 0;
  let prevCanvas: OffscreenCanvas | null = null;
  let prevRgba: Uint8ClampedArray | null = null;
  let processed = 0;
  let frameMs = 0;
  let lastFrameAt = 0;
  let inferMs = 0;
  let encodeMs = 0;
  let capped4kLogged = false;
  let stage: 'video-decode' | 'video-encode' = 'video-decode';
  try {
    for await (const sample of sink.samples()) {
      if (shouldCancel()) {
        await output.cancel();
        throw new Error('已取消。');
      }
      stageCtx.clearRect(0, 0, dw, dh);
      sample.draw(stageCtx, 0, 0, dw, dh);
      let canvas: OffscreenCanvas;
      const t0 = performance.now();
      if (ai) {
        canvas = await ai.processCanvas(stageCanvas, {
          halfInput: options.aiHalfInput,
          keepResolution: options.aiKeepResolution,
        });
      } else {
        canvas = await enhancer!.processFrame(stageCanvas, {
          scale: options.scale,
          sharpness: options.sharpness,
          allowBlackFrames: options.allowBlackFrames,
        });
      }
      const t1Proc = performance.now();
      if (ai && keepRes && (canvas.width !== dw || canvas.height !== dh)) {
        const back = new OffscreenCanvas(dw, dh);
        back.getContext('2d')!.drawImage(canvas, 0, 0, dw, dh);
        canvas = back;
      }
      if (canvas.width * canvas.height > 3840 * 2160) {
        const k = Math.min(3840 / canvas.width, 2160 / canvas.height);
        const cw = roundEven(canvas.width * k);
        const ch = roundEven(canvas.height * k);
        const scaled = new OffscreenCanvas(cw, ch);
        scaled.getContext('2d')!.drawImage(canvas, 0, 0, cw, ch);
        canvas = scaled;
        if (!capped4kLogged) {
          capped4kLogged = true;
          log('info', `输出超过 4K，已限制到 ${cw}x${ch}（避免 5K+ 软件编码过慢）`);
        }
      }
      const t1 = performance.now();
      if (inter) {
        const curRgba = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        if (prevCanvas && prevRgba) {
          stage = 'video-encode';
          try {
            const o1 = new VideoSample(prevCanvas, { timestamp: emitted * frameDur, duration: frameDur });
            await videoSource.add(o1);
            o1.close();
            // 相邻两帧之间均匀补 interpFactor-1 个中间帧（t = k/N）
            for (let k = 1; k < interpFactor; k++) {
              const mid = await inter.interpolate(prevRgba, curRgba, canvas.width, canvas.height, k / interpFactor);
              const midCanvas = new OffscreenCanvas(canvas.width, canvas.height);
              midCanvas.getContext('2d')!.putImageData(new ImageData(mid, canvas.width, canvas.height), 0, 0);
              const om = new VideoSample(midCanvas, { timestamp: (emitted + k) * frameDur, duration: frameDur });
              await videoSource.add(om);
              om.close();
            }
          } finally {
            stage = 'video-decode';
          }
          emitted += interpFactor;
        } else {
          stage = 'video-encode';
          try {
            const o1 = new VideoSample(canvas, { timestamp: emitted * frameDur, duration: frameDur });
            await videoSource.add(o1);
            o1.close();
          } finally {
            stage = 'video-decode';
          }
          emitted += 1;
        }
        prevCanvas = canvas;
        prevRgba = new Uint8ClampedArray(curRgba.buffer);
      } else {
        const outTs = Math.max(0, sample.timestamp - vBase);
        const out = new VideoSample(canvas, {
          timestamp: outTs,
          duration: sample.duration > 0 ? sample.duration : 1 / fps,
        });
        stage = 'video-encode';
        try {
          await videoSource.add(out);
        } finally {
          stage = 'video-decode';
        }
        out.close();
        sample.close();
      }
      if (!inter) sample.close();
      processed++;
      const t2 = performance.now();
      inferMs = inferMs === 0 ? t1Proc - t0 : inferMs * 0.8 + (t1Proc - t0) * 0.2;
      encodeMs = encodeMs === 0 ? t2 - t1 : encodeMs * 0.8 + (t2 - t1) * 0.2;
      const now = performance.now();
      if (lastFrameAt > 0) frameMs = frameMs * 0.8 + (now - lastFrameAt) * 0.2;
      lastFrameAt = now;
      if (processed % 20 === 0) {
        log('info', `进度 ${processed}/${totalFrames} 帧, 均 ${((frameMs / 1000) || 0).toFixed(1)}s/帧, 后端 ${aiEp === 'wasm' ? 'CPU' : 'GPU'}`);
      }
      onProgress({ phase: 'video', processed, total: totalFrames, aiEp, frameMs, inferMs, encodeMs });
      if (processed % 10 === 0) {
        log('info', `源帧 ${processed}/${totalFrames} 已出片 ${emitted} 帧, 推理 ${(inferMs / 1000).toFixed(2)}s + 编码 ${(encodeMs / 1000).toFixed(2)}s`);
      }
    }
    if (inter && prevCanvas) {
      const o = new VideoSample(prevCanvas, { timestamp: emitted * frameDur, duration: frameDur });
      stage = 'video-encode';
      try {
        await videoSource.add(o);
      } finally {
        stage = 'video-decode';
      }
      o.close();
    }
  } catch (err) {
    if (err instanceof Error && err.message === '已取消。') throw err;
    if (stage === 'video-encode') {
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
