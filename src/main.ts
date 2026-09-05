import { enhanceVideo, probeVideo, type EnhanceResult, type ScaleFactor } from './enhance';
import { enhanceImage } from './image';
import { onLog, onClear, getLogs, clearLogs, log, type LogEntry } from './logger';
import { asciiConvert, getAsciiCharset, type AsciiJobOptions, type AsciiOptions } from './ascii';

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el as T;
};

const dropZone = $('#drop-zone');
const fileInput = $('#file-input') as HTMLInputElement;
const controls = $('#controls');
const scaleRadios = document.querySelectorAll<HTMLInputElement>('input[name="scale"]');
const engineRadios = document.querySelectorAll<HTMLInputElement>('input[name="engine"]');
const scaleGroup = $('#scale-group');
const aiKeepResRow = $('#ai-keep-res-row');
const aiKeepRes = $('#ai-keep-res') as HTMLInputElement;
const sharpSlider = $('#sharpness') as HTMLInputElement;
const sharpValue = $('#sharpness-value');
const startBtn = $('#start-btn') as HTMLButtonElement;
const cancelBtn = $('#cancel-btn') as HTMLButtonElement;
const progressWrap = $('#progress-wrap');
const progressBar = $('#progress-bar') as HTMLDivElement;
const statusText = $('#status-text');
const resultSection = $('#result-section');
const resultInfo = $('#result-info');
const originalVideo = $('#original-video') as HTMLVideoElement;
const enhancedVideo = $('#enhanced-video') as HTMLVideoElement;
const downloadLink = $('#download-link') as HTMLAnchorElement;
const errorBox = $('#error-box');
const computeBadge = $('#compute-badge');
const engineBadge = $('#engine-badge');
const logPanel = $('#log-panel');
const logToggle = $('#log-toggle') as HTMLButtonElement;
const loupeCanvas = $('#loupe-canvas') as HTMLCanvasElement;
const loupePlayBtn = $('#loupe-play') as HTMLButtonElement;
const halfInputEl = $('#ai-half-input') as HTMLInputElement;
const enhanceOptions = $('#enhance-options');
const asciiOptions = $('#ascii-options');
const asciiCols = $('#ascii-cols') as HTMLInputElement;
const asciiColsValue = $('#ascii-cols-value');
const asciiColorEl = $('#ascii-color') as HTMLInputElement;
const asciiInvertEl = $('#ascii-invert') as HTMLInputElement;
const asciiThreshold = $('#ascii-threshold') as HTMLInputElement;
const asciiThresholdValue = $('#ascii-threshold-value');
const asciiBgColor = $('#ascii-bg-color') as HTMLInputElement;
const asciiFgColor = $('#ascii-fg-color') as HTMLInputElement;
const asciiPreviewCanvas = $('#ascii-preview-canvas') as HTMLCanvasElement;
const asciiPreviewVideo = $('#ascii-preview-video') as HTMLVideoElement;
const asciiPreviewSeek = $('#ascii-preview-seek') as HTMLInputElement;
const asciiPreviewPlayBtn = $('#ascii-preview-play') as HTMLButtonElement;
const asciiPreviewTime = $('#ascii-preview-time');

function badge(cls: string, text: string, el: HTMLElement): void {
  el.className = `badge ${cls}`;
  el.textContent = text;
}

function renderLog(e: LogEntry): void {
  const div = document.createElement('div');
  const span = (cls: string, text: string) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  div.appendChild(span('lg-time', e.time));
  div.appendChild(span(`lg-${e.level}`, e.msg));
  logPanel.appendChild(div);
  logPanel.scrollTop = logPanel.scrollHeight;
  while (logPanel.childElementCount > 500) logPanel.firstElementChild?.remove();
}

onLog(renderLog);
for (const e of getLogs()) renderLog(e);
onClear(() => {
  logPanel.innerHTML = '';
});

logToggle.addEventListener('click', () => {
  const open = logPanel.classList.toggle('open');
  logToggle.textContent = open ? '收起' : '展开';
});

($('#log-copy') as HTMLButtonElement).addEventListener('click', async () => {
  const text = getLogs()
    .map((e) => `[${e.time}][${e.level}] ${e.msg}`)
    .join('\n');
  if (!text) {
    log('warn', '日志为空，无可复制内容');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    log('info', `日志已复制（${getLogs().length} 条）`);
  } catch {
    // 非安全上下文 clipboard 不可用时降级
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      log('info', `日志已复制（${getLogs().length} 条）`);
    } catch {
      log('error', '复制失败：浏览器拒绝剪贴板写入');
    }
    ta.remove();
  }
});

let selectedFile: File | null = null;
let cancelFlag = false;
let running = false;
let resultUrl: string | null = null;
let originalUrl: string | null = null;

function setError(msg: string | null): void {
  errorBox.textContent = msg ?? '';
  errorBox.style.display = msg ? 'block' : 'none';
}

// 文件类型门控：图片只能走图片增强，视频不能走图片增强，不兼容的类别直接锁定
type FileKind = 'video' | 'image';
let fileKind: FileKind | null = null;

const VIDEO_ENGINES = ['fsr', 'imdn-x2', 'realesr-general-x4v3', 'realesr-animevideov3'];
const IMAGE_ENGINES = ['realesrgan-anime6b-x4', 'realcugan-se-2x-denoise3', 'realcugan-se-2x-conservative'];
const IMAGE_DEFAULT_ENGINE = 'realesrgan-anime6b-x4';

// 预设依赖的引擎不在当前文件类型的可见组时，预设一并隐藏
const PRESET_ENGINE: Record<string, string> = {
  anime: 'realesr-animevideov3',
  meme: 'realcugan-se-2x-denoise3',
  photo: 'realesr-general-x4v3',
};

function visibleEngines(): string[] {
  if (fileKind === 'image') return IMAGE_ENGINES;
  if (fileKind === 'video') return VIDEO_ENGINES;
  return [...VIDEO_ENGINES, ...IMAGE_ENGINES];
}

function selectEngine(v: string): void {
  for (const r of engineRadios) {
    if (r.value === v) {
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
  }
}

function isCategoryCompatible(value: string, kind: FileKind): boolean {
  return kind === 'image' ? value === 'image' : value !== 'image';
}

function applyFileKind(): void {
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="category"]')) {
    const label = r.closest('label');
    const ok = !fileKind || isCategoryCompatible(r.value, fileKind);
    r.disabled = !ok;
    label?.classList.toggle('locked', !ok);
    if (!ok && fileKind) {
      label?.setAttribute('title', fileKind === 'image' ? '已选择图片文件，仅支持图片增强' : '已选择视频文件，不支持图片增强');
    } else {
      label?.removeAttribute('title');
    }
  }
  // 引擎组按文件类型过滤：图片只见图片引擎，视频只见视频引擎
  $('#engine-video-group').style.display = fileKind === 'image' ? 'none' : 'block';
  $('#engine-image-group').style.display = fileKind === 'video' ? 'none' : 'block';
  if (fileKind && !visibleEngines().includes(currentEngine())) {
    selectEngine(fileKind === 'image' ? IMAGE_DEFAULT_ENGINE : 'fsr');
  }
  // 图片引擎自带倍数与锐化，缩放/锐化/插帧整区无意义，隐藏并上移后续编号
  $('#enhance-params').style.display = fileKind === 'image' ? 'none' : 'block';
  $('#accel-sec-num').textContent = fileKind === 'image' ? '3' : '4';
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.preset-btn')) {
    const dep = PRESET_ENGINE[btn.dataset.preset ?? ''];
    btn.style.display = dep && fileKind && !visibleEngines().includes(dep) ? 'none' : '';
  }
  if (fileKind && !isCategoryCompatible(currentMode(), fileKind)) {
    const target = fileKind === 'image' ? 'image' : 'enhance';
    document.querySelector<HTMLInputElement>(`input[name="category"][value="${target}"]`)?.click();
  }
}

function setFile(file: File | null): void {
  selectedFile = file;
  setError(null);
  resultSection.style.display = 'none';
  if (asciiPreviewUrl) {
    URL.revokeObjectURL(asciiPreviewUrl);
    asciiPreviewUrl = null;
  }
  stopAsciiPreviewPlayback();
  if (file) {
    fileKind = file.type.startsWith('image/') ? 'image' : 'video';
    applyFileKind();
    const sizeMb = (file.size / 1048576).toFixed(1);
    log('info', `已选文件: ${file.name} (${file.size < 1048576 ? `${(file.size / 1024).toFixed(0)}KB` : `${sizeMb}MB`}, ${file.type || '未知类型'})`);
    if (file.type.startsWith('image/')) {
      // 图片：直接读尺寸，不走视频探针/ASCII 预览
      createImageBitmap(file)
        .then((bmp) => {
          $('#file-meta').textContent = `${file.name} · ${bmp.width}×${bmp.height} · 图片`;
          bmp.close();
        })
        .catch(() => {
          $('#file-meta').textContent = `${file.name} · 图片（尺寸读取失败，仍可尝试处理）`;
        });
      controls.style.display = 'block';
      startBtn.disabled = false;
      return;
    }
    asciiPreviewUrl = URL.createObjectURL(file);
    asciiPreviewVideo.src = asciiPreviewUrl;
    asciiPreviewSeek.value = '0';
    asciiPreviewTime.textContent = '0.0s';
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = URL.createObjectURL(file);
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(v.src);
      $('#file-meta').textContent = `${file.name} · ${v.videoWidth}×${v.videoHeight} · ${(file.size / 1048576).toFixed(1)} MB`;
    };
    probeVideo(file)
      .then((info) => {
        const codecName = info.codec ?? '未知';
        $('#file-meta').textContent =
          `${file.name} · ${info.width}×${info.height} · ${(file.size / 1048576).toFixed(1)} MB · 编码 ${codecName}` +
          (info.codecString ? ` (${info.codecString})` : '') +
          (info.decodable ? '' : '（注意：浏览器报告不支持，仍将尝试解码）');
        log(
          info.decodable ? 'info' : 'warn',
          `探针: ${info.width}x${info.height}, 编码 ${codecName}${info.codecString ? ` (${info.codecString})` : ''}, 可解码=${info.decodable}`,
        );
      })
      .catch((e) => {
        log('warn', `探针失败（仍可尝试处理）: ${e instanceof Error ? e.message : String(e)}`);
      });
    controls.style.display = 'block';
    startBtn.disabled = false;
  } else {
    fileKind = null;
    applyFileKind();
    $('#file-meta').textContent = '';
    controls.style.display = 'none';
  }
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) setFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) setFile(fileInput.files[0]);
});

sharpSlider.addEventListener('input', () => {
  sharpValue.textContent = `${sharpSlider.value}%`;
});

function currentEngine(): string {
  for (const r of engineRadios) if (r.checked) return r.value;
  return 'fsr';
}

engineRadios.forEach((r) => {
  r.addEventListener('change', () => {
    const ai = currentEngine() !== 'fsr';
    scaleGroup.style.opacity = ai ? '0.4' : '1';
    (scaleGroup.style as CSSStyleDeclaration & { pointerEvents: string }).pointerEvents = ai
      ? 'none'
      : 'auto';
    $('#ai-note').style.display = ai ? 'inline' : 'none';
    aiKeepResRow.style.display = ai ? 'block' : 'none';
  });
});

// 一键预设：引擎 + 相关开关一键到位（触发 change 联动 UI 状态）
for (const btn of document.querySelectorAll<HTMLButtonElement>('.preset-btn')) {
  btn.addEventListener('click', () => {
    const fire = (el: HTMLInputElement) => el.dispatchEvent(new Event('change', { bubbles: true }));
    const setScale = (v: string) => {
      for (const r of scaleRadios) if (r.value === v) r.checked = true;
    };
    const setInterp = (v: string) => {
      for (const r of document.querySelectorAll<HTMLInputElement>('input[name="interp"]')) {
        if (r.value === v) r.checked = true;
      }
    };
    const preset = btn.dataset.preset ?? 'default';
    if (preset === 'anime') {
      selectEngine('realesr-animevideov3');
      aiKeepRes.checked = false;
      halfInputEl.checked = false;
      setInterp('none');
    } else if (preset === 'meme') {
      selectEngine('realcugan-se-2x-denoise3');
      halfInputEl.checked = false;
      aiKeepRes.checked = true;
      setInterp('none');
    } else if (preset === 'photo') {
      selectEngine('realesr-general-x4v3');
      aiKeepRes.checked = false;
      halfInputEl.checked = false;
      setInterp('none');
    } else {
      selectEngine(fileKind === 'image' ? IMAGE_DEFAULT_ENGINE : 'fsr');
      setScale('1');
      sharpSlider.value = '60';
      sharpValue.textContent = '60%';
      aiKeepRes.checked = false;
      halfInputEl.checked = false;
      ($('#hw-encode') as HTMLInputElement).checked = true;
      setInterp('none');
    }
    fire(aiKeepRes);
    log('info', `已应用预设：${btn.textContent?.trim()}`);
  });
}

// 性能模式与保持原分辨率互斥：半分辨率推理先缩小源，AI 修复再缩回，叠加等于双重抵消
aiKeepRes.addEventListener('change', () => {
  if (aiKeepRes.checked) halfInputEl.checked = false;
});
halfInputEl.addEventListener('change', () => {
  if (halfInputEl.checked) aiKeepRes.checked = false;
});

// 功能类别：画质增强 / 视频转 ASCII
asciiCols.addEventListener('input', () => {
  asciiColsValue.textContent = asciiCols.value;
  renderAsciiPreview();
});
asciiThreshold.addEventListener('input', () => {
  asciiThresholdValue.textContent = `${asciiThreshold.value}%`;
  renderAsciiPreview();
});
for (const el of [asciiColorEl, asciiInvertEl, asciiBgColor, asciiFgColor]) {
  el.addEventListener('change', () => renderAsciiPreview());
}
// 反转梯度时自动交换底/字色，保持"黑底白字↔白底黑字"的直觉
asciiInvertEl.addEventListener('change', () => {
  const bg = asciiBgColor.value;
  asciiBgColor.value = asciiFgColor.value;
  asciiFgColor.value = bg;
});
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="ascii-charset"]')) {
  r.addEventListener('change', () => renderAsciiPreview());
}
for (const btn of document.querySelectorAll<HTMLButtonElement>('.ascii-preset')) {
  btn.addEventListener('click', () => {
    asciiCols.value = btn.dataset.cols ?? '120';
    asciiColsValue.textContent = asciiCols.value;
    renderAsciiPreview();
  });
}

function currentMode(): 'enhance' | 'ascii' | 'image' {
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="category"]')) {
    if (r.checked) return r.value as 'enhance' | 'ascii' | 'image';
  }
  return 'enhance';
}

for (const r of document.querySelectorAll<HTMLInputElement>('input[name="category"]')) {
  r.addEventListener('change', () => {
    const mode = currentMode();
    const ascii = mode === 'ascii';
    const image = mode === 'image';
    enhanceOptions.style.display = ascii ? 'none' : 'block';
    asciiOptions.style.display = ascii ? 'block' : 'none';
    $('#image-options').style.display = image ? 'block' : 'none';
    // 图片无插帧/视频编码器
    $('#interp-row').style.display = image ? 'none' : 'block';
    $('#hw-row').style.display = image ? 'none' : 'block';
    fileInput.accept = image ? 'image/*' : 'video/*';
    if (ascii) renderAsciiPreview();
    else stopAsciiPreviewPlayback();
  });
}

const jpegQuality = $('#jpeg-quality') as HTMLInputElement;
jpegQuality.addEventListener('input', () => {
  $('#jpeg-quality-value').textContent = jpegQuality.value;
});
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="image-format"]')) {
  r.addEventListener('change', () => {
    const fmt = document.querySelector<HTMLInputElement>('input[name="image-format"]:checked')?.value ?? 'png';
    $('#jpeg-quality-row').style.display = fmt === 'jpeg' ? 'block' : 'none';
  });
}

// ===== ASCII 实时预览：隐藏 video 逐帧解码 → asciiConvert → 预览画布 =====
let asciiPreviewUrl: string | null = null;
let asciiPlaying = false;
let asciiRaf = 0;

function asciiJobOptsFromUi(): AsciiJobOptions {
  return {
    columns: Number(asciiCols.value),
    charsetId:
      document.querySelector<HTMLInputElement>('input[name="ascii-charset"]:checked')?.value ?? 'classic',
    color: asciiColorEl.checked,
    invert: asciiInvertEl.checked,
    threshold: Number(asciiThreshold.value),
    bgColor: asciiBgColor.value,
    fgColor: asciiFgColor.value,
  };
}

function renderAsciiPreview(): void {
  if (currentMode() !== 'ascii' || !selectedFile) return;
  const v = asciiPreviewVideo;
  if (v.readyState < 2 || !v.videoWidth) return;
  const off = new OffscreenCanvas(v.videoWidth, v.videoHeight);
  off.getContext('2d')!.drawImage(v, 0, 0);
  const job = asciiJobOptsFromUi();
  const opts: AsciiOptions = {
    columns: job.columns,
    charset: getAsciiCharset(job.charsetId),
    color: job.color,
    invert: job.invert,
    threshold: job.threshold,
    bgColor: job.bgColor,
    fgColor: job.fgColor,
  };
  const result = asciiConvert(off, opts);
  if (asciiPreviewCanvas.width !== result.width || asciiPreviewCanvas.height !== result.height) {
    asciiPreviewCanvas.width = result.width;
    asciiPreviewCanvas.height = result.height;
  }
  asciiPreviewCanvas.getContext('2d')!.drawImage(result, 0, 0);
}

function stopAsciiPreviewPlayback(): void {
  asciiPlaying = false;
  cancelAnimationFrame(asciiRaf);
  asciiPreviewVideo.pause();
  asciiPreviewPlayBtn.textContent = '▶ 预览播放';
}

function asciiPreviewLoop(): void {
  if (!asciiPlaying) return;
  renderAsciiPreview();
  const dur = asciiPreviewVideo.duration || 1;
  asciiPreviewSeek.value = String(Math.round((asciiPreviewVideo.currentTime / dur) * 1000));
  asciiPreviewTime.textContent = `${asciiPreviewVideo.currentTime.toFixed(1)}s / ${dur.toFixed(1)}s`;
  asciiRaf = requestAnimationFrame(asciiPreviewLoop);
}

asciiPreviewPlayBtn.addEventListener('click', () => {
  if (asciiPlaying) {
    stopAsciiPreviewPlayback();
    return;
  }
  asciiPlaying = true;
  asciiPreviewPlayBtn.textContent = '⏸ 暂停预览';
  asciiPreviewVideo.play().catch(() => stopAsciiPreviewPlayback());
  asciiRaf = requestAnimationFrame(asciiPreviewLoop);
});

asciiPreviewVideo.addEventListener('ended', () => stopAsciiPreviewPlayback());
asciiPreviewVideo.addEventListener('seeked', () => renderAsciiPreview());
asciiPreviewVideo.addEventListener('loadeddata', () => {
  // 某些环境（headless/部分合成器）未 seek 过的视频 drawImage 出黑帧，先跳到 1/3 处触发帧解码
  if (asciiPreviewVideo.duration > 0.1) {
    asciiPreviewVideo.currentTime = asciiPreviewVideo.duration / 3;
  }
  renderAsciiPreview();
});
asciiPreviewSeek.addEventListener('input', () => {
  stopAsciiPreviewPlayback();
  const dur = asciiPreviewVideo.duration || 0;
  asciiPreviewVideo.currentTime = (Number(asciiPreviewSeek.value) / 1000) * dur;
  asciiPreviewTime.textContent = `${asciiPreviewVideo.currentTime.toFixed(1)}s / ${dur.toFixed(1)}s`;
});

cancelBtn.addEventListener('click', () => {
  cancelFlag = true;
  cancelBtn.disabled = true;
  statusText.textContent = '正在取消…';
  log('warn', '用户点击取消，等待当前帧收尾后中止');
});

startBtn.addEventListener('click', async () => {
  if (!selectedFile || running) return;

  let scale: ScaleFactor = 1;
  for (const r of scaleRadios) {
    if (r.checked) scale = Number(r.value) as ScaleFactor;
  }
  const sharpness = Number(sharpSlider.value) / 100;
  const engine = currentEngine();
  let interpolation: 'none' | 'x2' | 'x4' = 'none';
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="interp"]')) {
    if (r.checked) interpolation = r.value as 'none' | 'x2' | 'x4';
  }
  const aiKeepResolution = engine !== 'fsr' ? aiKeepRes.checked : false;
  const aiHalfInput = engine !== 'fsr' ? halfInputEl.checked : false;
  const hwEncode = ($('#hw-encode') as HTMLInputElement).checked;
  const mode = currentMode();
  const ascii: AsciiJobOptions | undefined =
    mode === 'ascii'
      ? {
          columns: Number(asciiCols.value),
          charsetId:
            document.querySelector<HTMLInputElement>('input[name="ascii-charset"]:checked')?.value ?? 'classic',
          color: asciiColorEl.checked,
          invert: asciiInvertEl.checked,
          threshold: Number(asciiThreshold.value),
          bgColor: asciiBgColor.value,
          fgColor: asciiFgColor.value,
        }
      : undefined;

  running = true;
  cancelFlag = false;
  startBtn.disabled = true;
  cancelBtn.disabled = false;
  progressWrap.style.display = 'block';
  setError(null);
  resultSection.style.display = 'none';
  badge('none', '引擎初始化…', computeBadge);
  badge('none', '', engineBadge);
  logPanel.classList.add('open');
  logToggle.textContent = '收起';
  // 新任务清空上次日志，避免干扰
  clearLogs();

  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
  if (originalUrl) {
    URL.revokeObjectURL(originalUrl);
    originalUrl = null;
  }

  log(
    'info',
    `任务参数: 模式=${mode}, 引擎=${engine}, 缩放=${engine !== 'fsr' ? `(AI 自带${aiKeepResolution ? ' + 保持原分辨率' : ''}${aiHalfInput ? ' + 半分辨率推理' : ''})` : `${scale}x`}` +
      `, 锐度=${Math.round(sharpness * 100)}%, 插帧=${interpolation}, 硬件编码=${hwEncode ? '开' : '关'}`,
  );

  if (mode === 'image') {
    const format = (document.querySelector<HTMLInputElement>('input[name="image-format"]:checked')?.value ?? 'png') as 'png' | 'jpeg';
    const jpegQ = Number(($('#jpeg-quality') as HTMLInputElement).value) / 100;
    log('info', `图片任务参数: 引擎=${engine}, 格式=${format}${format === 'jpeg' ? `, 质量=${Math.round(jpegQ * 100)}` : ''}`);
    try {
      const imgRes = await enhanceImage(
        { file: selectedFile, engine, scale, sharpness, aiKeepResolution, aiHalfInput, format, jpegQuality: jpegQ },
        (phase) => {
          statusText.textContent =
            phase === 'decode' ? '解码图片中…' : phase === 'model' ? '初始化 AI 引擎…' : phase === 'infer' ? 'AI 增强中…' : '编码输出中…';
          progressBar.style.width = phase === 'decode' ? '10%' : phase === 'model' ? '25%' : phase === 'infer' ? '60%' : '90%';
          badge('none', phase === 'infer' ? '增强中…' : '处理中…', computeBadge);
          badge('none', engine === 'fsr' ? '算法增强' : 'AI 引擎', engineBadge);
        },
        () => cancelFlag,
      );
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      resultUrl = URL.createObjectURL(imgRes.blob);
      originalUrl = URL.createObjectURL(selectedFile);
      ($('#original-img') as HTMLImageElement).src = originalUrl;
      ($('#enhanced-img') as HTMLImageElement).src = resultUrl;
      downloadLink.href = resultUrl;
      const baseName = selectedFile.name.replace(/\.[^.]+$/, '');
      downloadLink.download = `${baseName}-enhanced.${format === 'jpeg' ? 'jpg' : 'png'}`;
      downloadLink.textContent = `下载增强后的 ${format === 'jpeg' ? 'JPG' : 'PNG'}`;
      resultInfo.textContent =
        `输出 ${imgRes.width}×${imgRes.height} · 耗时 ${(imgRes.elapsedMs / 1000).toFixed(1)}s · ` +
        `文件大小 ${(imgRes.blob.size / 1024).toFixed(0)} KB`;
      log('info', `图片任务成功: ${imgRes.width}x${imgRes.height}, ${(imgRes.blob.size / 1024).toFixed(0)}KB`);
      progressWrap.style.display = 'none';
      $('#video-compare').style.display = 'none';
      $('#image-compare').style.display = 'grid';
      $('#loupe-panel').style.display = 'none';
      resultSection.style.display = 'block';
    } catch (err) {
      progressWrap.style.display = 'none';
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== '已取消。') {
        log('error', `图片任务失败: ${msg}`);
        setError(msg);
      } else {
        log('warn', '图片任务已取消');
      }
    } finally {
      running = false;
      startBtn.disabled = !selectedFile;
      cancelBtn.disabled = true;
    }
    return;
  }

  try {
    const result: EnhanceResult = await enhanceVideo(
      { file: selectedFile, scale, sharpness, engine, aiKeepResolution, aiHalfInput, interpolation, hwEncode, mode, ascii },
      ({ phase, processed, total, modelStage, aiEp, frameMs, inferMs, interpMs, encodeMs }) => {
        if (phase === 'analyze') {
          statusText.textContent = '分析视频中…';
          progressBar.style.width = '5%';
          badge('none', '分析中…', computeBadge);
        } else if (phase === 'model') {
          const label =
            modelStage === 'fetch' ? '下载 AI 模型（首次使用后离线缓存）…'
            : modelStage === 'compile' ? '初始化 AI 引擎…'
            : 'AI 引擎就绪';
          statusText.textContent = label;
          progressBar.style.width = '10%';
          if (modelStage === 'fetch') badge('model', '下载模型…', computeBadge);
          if (modelStage === 'compile') badge('model', '初始化推理引擎…', computeBadge);
        } else if (phase === 'video') {
          const pct = total > 0 ? Math.min(99, Math.round((processed / total) * 100)) : 0;
          const parts: string[] = [];
          if (inferMs && inferMs > 0) parts.push(`推理 ${(inferMs / 1000).toFixed(2)}s`);
          if (interpMs && interpMs > 0) parts.push(`插帧 ${(interpMs / 1000).toFixed(2)}s`);
          if (encodeMs && encodeMs > 0) parts.push(`编码 ${(encodeMs / 1000).toFixed(2)}s`);
          const speed = parts.length ? ` · ${parts.join(' + ')} /帧` : frameMs && frameMs > 0 ? ` · ${(frameMs / 1000).toFixed(1)}s/帧` : '';
          statusText.textContent = `处理中 ${processed}/${total} 帧 (${pct}%)${speed}`;
          statusText.style.color = aiEp === 'wasm' ? '#ffb4ba' : '';
          if (aiEp === 'wasm') {
            badge('cpu', 'CPU 软件推理：慢 10 倍以上，建议排查 GPU', computeBadge);
          } else {
            badge('gpu', 'GPU 加速中 (WebGPU)', computeBadge);
          }
          badge('none', mode === 'ascii' ? 'ASCII 转换' : engine === 'fsr' ? '算法增强' : 'AI 引擎', engineBadge);
          progressBar.style.width = `${pct}%`;
        }
      },
      () => cancelFlag,
    );

    resultUrl = URL.createObjectURL(result.blob);
    originalUrl = URL.createObjectURL(selectedFile);
    originalVideo.src = originalUrl;
    enhancedVideo.src = resultUrl;
    downloadLink.href = resultUrl;
    const baseName = selectedFile.name.replace(/\.[^.]+$/, '');
    downloadLink.download = `${baseName}-${mode === 'ascii' ? 'ascii' : 'enhanced'}.mp4`;
    $('#enhanced-cap').textContent = mode === 'ascii' ? 'ASCII 转换后' : '增强后';

    const secs = (result.elapsedMs / 1000).toFixed(1);
    resultInfo.textContent =
      `${result.processedFrames} 帧 · 输出 ${result.width}×${result.height} · 耗时 ${secs}s · ` +
      `文件大小 ${(result.blob.size / 1048576).toFixed(1)} MB`;
    log('info', `任务成功: ${result.processedFrames} 帧 → ${result.width}x${result.height}, 耗时 ${secs}s, 输出 ${(result.blob.size / 1048576).toFixed(1)}MB`);
    downloadLink.textContent = '下载增强后的 MP4';
    progressWrap.style.display = 'none';
    $('#video-compare').style.display = 'grid';
    $('#image-compare').style.display = 'none';
    $('#loupe-panel').style.display = 'block';
    resultSection.style.display = 'block';
    resetLoupe();
  } catch (err) {
    progressWrap.style.display = 'none';
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== '已取消。') {
      log('error', `任务失败: ${msg}`);
      setError(msg);
    } else {
      log('warn', '任务已取消');
    }
  } finally {
    running = false;
    startBtn.disabled = !selectedFile;
    cancelBtn.disabled = true;
  }
});

// ===== 1:1 放大镜对比 =====
// 左半显示原始视频、右半显示增强视频的同一内容区域，按原始视频像素放大。
// 超分/锐化的增益是像素级的，缩略对比必然看不出，必须 1:1 观察。
let loupeZoom = 2;
let loupeCenterX = 0.5;
let loupeCenterY = 0.5;
let loupePointerId: number | null = null;

function resetLoupe(): void {
  loupeCenterX = 0.5;
  loupeCenterY = 0.5;
  loupePlaying = false;
  loupePlayBtn.textContent = '▶ 同步播放';
}

for (const r of document.querySelectorAll<HTMLInputElement>('input[name="loupe-zoom"]')) {
  r.addEventListener('change', () => {
    if (r.checked) loupeZoom = Number(r.value);
  });
}

let loupePlaying = false;

function syncLoupePlayback(): void {
  // 暂停时不做 seek：每帧 rAF 都 seek 会让暂停帧抖动、浪费解码
  if (originalVideo.paused) return;
  if (Math.abs(enhancedVideo.currentTime - originalVideo.currentTime) > 0.04) {
    enhancedVideo.currentTime = originalVideo.currentTime;
  }
}

loupePlayBtn.addEventListener('click', async () => {
  if (loupePlaying) {
    originalVideo.pause();
    enhancedVideo.pause();
  } else {
    syncLoupePlayback();
    try {
      await Promise.all([originalVideo.play(), enhancedVideo.play()]);
    } catch {
      /* 自动播放被拦截时忽略 */
    }
  }
});

originalVideo.addEventListener('play', () => {
  loupePlaying = true;
  loupePlayBtn.textContent = '⏸ 暂停';
  // 原生控件只会播自己，把增强侧也带上，避免双窗不同步
  if (enhancedVideo.paused) {
    syncLoupePlayback();
    enhancedVideo.play().catch(() => {});
  }
});
originalVideo.addEventListener('pause', () => {
  loupePlaying = false;
  loupePlayBtn.textContent = '▶ 同步播放';
  if (!enhancedVideo.paused) enhancedVideo.pause();
});

function loupeMoveTo(e: PointerEvent): void {
  const rect = loupeCanvas.getBoundingClientRect();
  loupeCenterX = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  loupeCenterY = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
}

loupeCanvas.addEventListener('pointerdown', (e) => {
  loupePointerId = e.pointerId;
  loupeCanvas.setPointerCapture(e.pointerId);
  loupeMoveTo(e);
});
loupeCanvas.addEventListener('pointermove', (e) => {
  if (loupePointerId === e.pointerId) loupeMoveTo(e);
});
const loupeRelease = (e: PointerEvent) => {
  if (loupePointerId === e.pointerId) loupePointerId = null;
};
loupeCanvas.addEventListener('pointerup', loupeRelease);
loupeCanvas.addEventListener('pointercancel', loupeRelease);

function drawLoupe(): void {
  if (resultSection.style.display !== 'none') {
    const ow = originalVideo.videoWidth;
    const oh = originalVideo.videoHeight;
    const ew = enhancedVideo.videoWidth;
    const eh = enhancedVideo.videoHeight;
    if (ow > 0 && oh > 0 && ew > 0 && eh > 0) {
      syncLoupePlayback();
      const ctx = loupeCanvas.getContext('2d')!;
      const cw = loupeCanvas.width;
      const ch = loupeCanvas.height;
      // 观察区域大小（原始视频像素），放大后铺满画布
      const rw = Math.min(ow, cw / loupeZoom);
      const rh = Math.min(oh, ch / loupeZoom);
      const sx = Math.min(Math.max(loupeCenterX * ow - rw / 2, 0), ow - rw);
      const sy = Math.min(Math.max(loupeCenterY * oh - rh / 2, 0), oh - rh);
      const k = ew / ow;
      // 关闭平滑：最近邻呈现真实像素块，才能判断锐度差异
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(originalVideo, sx, sy, rw, rh, 0, 0, cw / 2, ch);
      ctx.drawImage(enhancedVideo, sx * k, sy * k, rw * k, rh * k, cw / 2, 0, cw / 2, ch);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cw / 2 + 0.5, 0);
      ctx.lineTo(cw / 2 + 0.5, ch);
      ctx.stroke();
      ctx.font = '14px sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(8, 8, 58, 24);
      ctx.fillRect(cw / 2 + 8, 8, 70, 24);
      ctx.fillStyle = '#fff';
      ctx.fillText('原始', 16, 25);
      ctx.fillText('增强后', cw / 2 + 16, 25);
    }
  }
  requestAnimationFrame(drawLoupe);
}
requestAnimationFrame(drawLoupe);

resetLoupe();
