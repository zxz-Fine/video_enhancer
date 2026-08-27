import { enhanceVideo, probeVideo, type EnhanceResult, type ScaleFactor } from './enhance';
import { onLog, getLogs, type LogEntry } from './logger';

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

logToggle.addEventListener('click', () => {
  const open = logPanel.classList.toggle('open');
  logToggle.textContent = open ? '▲ 收起日志' : '▼ 运行日志';
});

let selectedFile: File | null = null;
let cancelFlag = false;
let running = false;
let resultUrl: string | null = null;

function setError(msg: string | null): void {
  errorBox.textContent = msg ?? '';
  errorBox.style.display = msg ? 'block' : 'none';
}

function setFile(file: File | null): void {
  selectedFile = file;
  setError(null);
  resultSection.style.display = 'none';
  if (file) {
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
          (info.decodable ? '' : ' · ⚠️ 浏览器报告不支持，仍将尝试解码');
      })
      .catch(() => {});
    controls.style.display = 'block';
    startBtn.disabled = false;
  } else {
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

cancelBtn.addEventListener('click', () => {
  cancelFlag = true;
  cancelBtn.disabled = true;
  statusText.textContent = '正在取消…';
});

startBtn.addEventListener('click', async () => {
  if (!selectedFile || running) return;

  let scale: ScaleFactor = 1;
  for (const r of scaleRadios) {
    if (r.checked) scale = Number(r.value) as ScaleFactor;
  }
  const sharpness = Number(sharpSlider.value) / 100;
  const engine = currentEngine();
  const aiKeepResolution = engine !== 'fsr' ? aiKeepRes.checked : false;
  const aiHalfInput = engine !== 'fsr' ? (document.getElementById('ai-half-input') as HTMLInputElement).checked : false;

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
  logToggle.textContent = '▲ 收起日志';

  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }

  try {
    const result: EnhanceResult = await enhanceVideo(
      { file: selectedFile, scale, sharpness, engine, aiKeepResolution, aiHalfInput },
      ({ phase, processed, total, modelStage, aiEp, frameMs, inferMs, encodeMs }) => {
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
          if (encodeMs && encodeMs > 0) parts.push(`编码 ${(encodeMs / 1000).toFixed(2)}s`);
          const speed = parts.length ? ` · ${parts.join(' + ')} /帧` : frameMs && frameMs > 0 ? ` · ${(frameMs / 1000).toFixed(1)}s/帧` : '';
          statusText.textContent = `处理中 ${processed}/${total} 帧 (${pct}%)${speed}`;
          statusText.style.color = aiEp === 'wasm' ? '#ffb4ba' : '';
          if (aiEp === 'wasm') {
            badge('cpu', '⚠ CPU 软件推理 — 速度慢 10 倍以上，建议排查 GPU', computeBadge);
          } else {
            badge('gpu', '✓ GPU 加速中 (WebGPU)', computeBadge);
          }
          badge('none', engine === 'fsr' ? '算法增强' : 'AI 引擎', engineBadge);
          progressBar.style.width = `${pct}%`;
        }
      },
      () => cancelFlag,
    );

    resultUrl = URL.createObjectURL(result.blob);
    originalVideo.src = URL.createObjectURL(selectedFile);
    enhancedVideo.src = resultUrl;
    downloadLink.href = resultUrl;
    const baseName = selectedFile.name.replace(/\.[^.]+$/, '');
    downloadLink.download = `${baseName}-enhanced.mp4`;

    const secs = (result.elapsedMs / 1000).toFixed(1);
    resultInfo.textContent =
      `${result.processedFrames} 帧 · 输出 ${result.width}×${result.height} · 耗时 ${secs}s · ` +
      `文件大小 ${(result.blob.size / 1048576).toFixed(1)} MB`;
    progressWrap.style.display = 'none';
    resultSection.style.display = 'block';
  } catch (err) {
    progressWrap.style.display = 'none';
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== '已取消。') setError(msg);
  } finally {
    running = false;
    startBtn.disabled = !selectedFile;
    cancelBtn.disabled = true;
  }
});
