import { EASU_SHADER, RCAS_SHADER, CAS_SHADER } from './shaders';
import { log } from './logger';

export type ScaleFactor = 1 | 2 | 4;

export interface FrameEnhancerOptions {
  scale: ScaleFactor;
  /** 0..1，越大越锐 */
  sharpness: number;
  /** headless/软渲染测试用：跳过全黑帧保护 */
  allowBlackFrames?: boolean;
}

const UNIFORM_BYTES = 80;

export class FrameEnhancer {
  private device: GPUDevice;
  private easu!: GPUComputePipeline;
  private rcas!: GPUComputePipeline;
  private cas!: GPUComputePipeline;
  private bgl!: GPUBindGroupLayout;
  private ubo!: GPUBuffer;
  private textures = new Map<string, GPUTexture>();
  private binds = new Map<string, GPUBindGroup>();

  private constructor(device: GPUDevice) {
    this.device = device;
    const mkModule = (code: string) => device.createShaderModule({ code });
    this.bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: {} },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba8unorm' },
        },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
    const make = (code: string) =>
      device.createComputePipeline({
        layout,
        compute: { module: mkModule(code), entryPoint: 'main' },
      });
    this.easu = make(EASU_SHADER);
    this.rcas = make(RCAS_SHADER);
    this.cas = make(CAS_SHADER);
    this.ubo = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.addEventListener?.('uncapturederror', (e: Event) => {
      const msg = (e as GPUUncapturedErrorEvent).error?.message ?? String(e);
      if (!this.lastGpuError) this.lastGpuError = msg;
      log('error', `[WebGPU] ${msg.slice(0, 200)}`);
    });
  }

  static async create(): Promise<FrameEnhancer> {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      throw new Error(
        'WebGPU 仅在安全上下文可用。当前通过 HTTP+IP 访问。请使用 https:// 地址（开发服务器已自带自签证书，首次访问点“高级→继续前往”即可），或在本机用 localhost 访问。',
      );
    }
    if (!('gpu' in navigator) || !navigator.gpu) {
      throw new Error(
        '此浏览器不支持 WebGPU。请使用最新版 Chrome / Edge（电脑），或 Android Chrome 121+。iOS 上的第三方浏览器不支持。',
      );
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('无法获取 GPU 适配器，WebGPU 初始化失败。');
    }
    const info = adapter.info;
    log('gpu', `GPU 适配器: ${info?.vendor || '?'} ${info?.architecture || ''} ${info?.description || ''}`.trim());
    const feats = Array.from(adapter.features);
    log('gpu', `GPU 特性: ${feats.join(', ') || '(无)'}`);
    const device = await adapter.requestDevice();
    const limits = device.limits;
    log('gpu', `GPU 上限: 纹理 ${limits.maxTextureDimension2D}², 存储纹理 ${limits.maxStorageTexturesPerShaderStage}/着色器, 缓冲 ${Math.round(limits.maxBufferSize / 1048576)}MB`);
    const enhancer = new FrameEnhancer(device);
    log('gpu', 'WebGPU 管线创建完成 (EASU 超分 / RCAS 锐化 / CAS 锐化)');
    return enhancer;
  }

  private lastGpuError: string | null = null;
  private modeLogged = false;

  private getTexture(key: string, width: number, height: number): GPUTexture {
    let tex = this.textures.get(key);
    if (!tex || tex.width !== width || tex.height !== height) {
      tex?.destroy();
      tex = this.device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });
      this.textures.set(key, tex);
      for (const k of [...this.binds.keys()]) {
        if (k.includes(`|${key}|`) || k.endsWith(`|${key}`)) this.binds.delete(k);
      }
    }
    return tex;
  }

  private getSourceTexture(width: number, height: number): GPUTexture {
    const key = `src-${width}x${height}`;
    let tex = this.textures.get(key);
    if (!tex || tex.width !== width || tex.height !== height) {
      tex?.destroy();
      tex = this.device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.textures.set(key, tex);
      for (const k of [...this.binds.keys()]) {
        if (k.includes(`|${key}|`) || k.endsWith(`|${key}`)) this.binds.delete(k);
      }
    }
    return tex;
  }

  private getBind(
    id: string,
    srcKey: string,
    srcTex: GPUTexture,
    dstKey: string,
    dstTex: GPUTexture,
  ): GPUBindGroup {
    const key = `${id}|${srcKey}|${dstKey}`;
    let bind = this.binds.get(key);
    if (!bind) {
      bind = this.device.createBindGroup({
        layout: this.bgl,
        entries: [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: { buffer: this.ubo } },
          { binding: 2, resource: dstTex.createView() },
        ],
      });
      this.binds.set(key, bind);
    }
    return bind;
  }

  private writeUniforms(data: Float32Array): void {
    this.device.queue.writeBuffer(this.ubo, 0, data, 0, 20);
  }

  private dispatch(
    pipeline: GPUComputePipeline,
    id: string,
    srcKey: string,
    srcTex: GPUTexture,
    dstKey: string,
    dstTex: GPUTexture,
    outW: number,
    outH: number,
  ): void {
    const bind = this.getBind(id, srcKey, srcTex, dstKey, dstTex);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(outW / 8), Math.ceil(outH / 8));
    pass.end();
    this.device.pushErrorScope('validation');
    this.device.queue.submit([enc.finish()]);
    this.device.popErrorScope().then((info) => {
      if (info && !this.lastGpuError) {
        this.lastGpuError = info.message;
        console.error('[WebGPU validation]', info.message);
      }
    });
  }

  private easuUniforms(inW: number, inH: number, outW: number, outH: number): Float32Array {
    const f = new Float32Array(20);
    f[0] = inW / outW;
    f[1] = inH / outH;
    f[2] = 0.5 * (inW / outW) - 0.5;
    f[3] = 0.5 * (inH / outH) - 0.5;
    f[4] = 1 / inW;
    f[5] = 1 / inH;
    f[6] = 1 / inW;
    f[7] = -1 / inH;
    f[8] = -1 / inW;
    f[9] = 2 / inH;
    f[10] = 1 / inW;
    f[11] = 2 / inH;
    f[12] = 0;
    f[13] = 4 / inH;
    f[16] = outW;
    f[17] = outH;
    f[18] = inW;
    f[19] = inH;
    return f;
  }

  private uploadMode: 'external' | 'writeTexture' | null = null;

  private async uploadAndVerify(
    source: OffscreenCanvas,
    srcTex: GPUTexture,
    w: number,
    h: number,
  ): Promise<void> {
    if (this.uploadMode === 'writeTexture') {
      const img = source.getContext('2d')!.getImageData(0, 0, w, h);
      this.device.queue.writeTexture(
        { texture: srcTex },
        img.data,
        { bytesPerRow: w * 4, rowsPerImage: h },
        [w, h],
      );
      return;
    }
    this.device.queue.copyExternalImageToTexture(
      { source },
      { texture: srcTex },
      [w, h],
    );
    if (this.uploadMode === null) {
      this.uploadMode = 'external';
      const readBuf = this.device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: srcTex, origin: [Math.floor(w / 2), Math.floor(h / 2)] },
        { buffer: readBuf, bytesPerRow: 256 },
        [1, 1],
      );
      this.device.queue.submit([enc.finish()]);
      await readBuf.mapAsync(GPUMapMode.READ);
      const px = new Uint8Array(readBuf.getMappedRange());
      // unmap 后映射分离，值必须在 unmap 前取出
      const p0 = px[0];
      const p1 = px[1];
      const p2 = px[2];
      const sum = p0 + p1 + p2;
      readBuf.unmap();
      readBuf.destroy();
      if (sum === 0) {
        this.uploadMode = 'writeTexture';
        log('warn', 'copyExternalImageToTexture 上传为黑帧 → 切换 CPU 直写纹理通道');
      } else {
        log('gpu', `纹理上传通路正常 (探针 ${p0},${p1},${p2})`);
      }
    }
  }

  async processFrame(source: OffscreenCanvas, options: FrameEnhancerOptions): Promise<OffscreenCanvas> {
    const inW = source.width;
    const inH = source.height;
    if (!this.modeLogged) {
      this.modeLogged = true;
      log(
        'gpu',
        options.scale === 1
          ? `算法增强首帧: ${inW}x${inH} CAS 锐化（锐度 ${Math.round(options.sharpness * 100)}%），后续帧不再重复记录`
          : `算法增强首帧: ${inW}x${inH} → ${inW * options.scale}x${inH * options.scale} FSR 超分 + RCAS 锐化（锐度 ${Math.round(options.sharpness * 100)}%），后续帧不再重复记录`,
      );
    }

    const srcKey = `src-${inW}x${inH}`;
    const srcTex = this.getSourceTexture(inW, inH);
    await this.uploadAndVerify(source, srcTex, inW, inH);

    let curKey = srcKey;
    let curTex = srcTex;
    let curW = inW;
    let curH = inH;

    if (options.scale === 1) {
      const outKey = `cas-${curW}x${curH}`;
      const outTex = this.getTexture(outKey, curW, curH);
      const u = new Float32Array(20);
      u[0] = options.sharpness;
      u[16] = curW;
      u[17] = curH;
      u[18] = curW;
      u[19] = curH;
      this.writeUniforms(u);
      this.dispatch(this.cas, 'cas', curKey, curTex, outKey, outTex, curW, curH);
      curKey = outKey;
      curTex = outTex;
    } else {
      const stops = Math.max(0.05, (1.0 - options.sharpness) * 2.0);
      const steps = options.scale / 2;
      for (let step = 0; step < steps; step++) {
        const outW = curW * 2;
        const outH = curH * 2;

        const easuKey = `easu-s${step}-${outW}x${outH}`;
        const easuTex = this.getTexture(easuKey, outW, outH);
        this.writeUniforms(this.easuUniforms(curW, curH, outW, outH));
        this.dispatch(this.easu, `easu${step}`, curKey, curTex, easuKey, easuTex, outW, outH);

        const rcasKey = `rcas-s${step}-${outW}x${outH}`;
        const rcasTex = this.getTexture(rcasKey, outW, outH);
        const ru = new Float32Array(20);
        ru[0] = Math.pow(2.0, -stops);
        ru[16] = outW;
        ru[17] = outH;
        ru[18] = outW;
        ru[19] = outH;
        this.writeUniforms(ru);
        this.dispatch(this.rcas, `rcas${step}`, easuKey, easuTex, rcasKey, rcasTex, outW, outH);

        curKey = rcasKey;
        curTex = rcasTex;
        curW = outW;
        curH = outH;
      }
    }

    await this.device.queue.onSubmittedWorkDone();

    const bytesPerRow = Math.ceil((curW * 4) / 256) * 256;
    const readBuf = this.device.createBuffer({
      size: bytesPerRow * curH,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: curTex },
      { buffer: readBuf, bytesPerRow, rowsPerImage: curH },
      [curW, curH],
    );
    this.device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(readBuf.getMappedRange());

    const packed = new Uint8ClampedArray(curW * curH * 4);
    for (let y = 0; y < curH; y++) {
      packed.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + curW * 4), y * curW * 4);
    }
    readBuf.unmap();
    readBuf.destroy();

    if (this.lastGpuError) {
      const msg = this.lastGpuError;
      this.lastGpuError = null;
      throw new Error(`GPU 处理出错：${msg}`);
    }

    let lumaSum = 0;
    for (let i = 0; i < packed.length; i += 4 * 97) {
      lumaSum += packed[i] + packed[i + 1] + packed[i + 2];
    }
    if (lumaSum === 0 && curW > 0 && !options.allowBlackFrames) {
      throw new Error(
        this.uploadMode === 'writeTexture'
          ? 'CPU 直写后输出仍为全黑：解码出的视频帧本身是黑帧，请用其他播放器确认该视频是否正常。'
          : 'GPU 输出全黑且探针未拦截，请把日志面板内容报告给开发者。',
      );
    }

    const canvas = new OffscreenCanvas(curW, curH);
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(packed, curW, curH), 0, 0);
    return canvas;
  }

  destroy(): void {
    log('gpu', `WebGPU 资源已释放（纹理 ${this.textures.size} 个，绑定组 ${this.binds.size} 个）`);
    for (const tex of this.textures.values()) tex.destroy();
    this.textures.clear();
    this.binds.clear();
    this.ubo.destroy();
    this.device.destroy();
  }
}
