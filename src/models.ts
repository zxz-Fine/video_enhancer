export interface ModelInfo {
  id: string;
  name: string;
  file: string;
  /** 权重修订号：换权重/重导 fp16 时 +1，拼进缓存键，强制失效浏览器旧缓存 */
  rev: number;
  scale: 2 | 4;
  sizeMB: number;
  scene: 'general' | 'anime';
  /** 模型期望的像素输入范围：255 或 1 */
  inputRange: 255 | 1;
  /** 单块边长（显存/内存预算）：默认 768；大参数模型调小（如 anime6b 用 384，否则单块 OOM） */
  tile?: number;
  note: string;
}

export const AI_MODELS: ModelInfo[] = [
  {
    id: 'imdn-x2',
    name: 'AI · 极速增强',
    file: '/models/imdn-x2.onnx',
    rev: 1,
    scale: 2,
    sizeMB: 0.4,
    scene: 'general',
    inputRange: 255,
    note: '通用视频 · 2x · 速度最快，高清源轻度增强',
  },
  {
    id: 'realesr-general-x4v3',
    name: 'AI · 通用 4x',
    file: '/models/realesr-general-x4v3.onnx',
    rev: 1,
    scale: 4,
    sizeMB: 4.9,
    scene: 'general',
    inputRange: 1,
    note: '真人/实拍/通用 · 4x · 带轻度降噪，低清实拍首选',
  },
  {
    id: 'realesr-animevideov3',
    name: 'AI · 动漫增强',
    file: '/models/realesr-animevideov3.onnx',
    rev: 3,
    scale: 4,
    sizeMB: 2.4,
    scene: 'anime',
    inputRange: 1,
    note: '动漫/手绘/插画视频专用 · 4x · XS 轻量，时域稳定',
  },
  {
    id: 'realesrgan-anime6b-x4',
    name: 'AI · 插画 4x',
    file: '/models/realesrgan-anime6b-x4.onnx',
    rev: 1,
    scale: 4,
    sizeMB: 17.5,
    scene: 'anime',
    inputRange: 1,
    tile: 384,
    note: '动漫插画/静图专用 · 4x · 细节重建强（图片模式首选）',
  },
  {
    id: 'realcugan-se-2x-denoise3',
    name: 'AI · 表情包修复',
    file: '/models/realcugan-se-2x-denoise3.onnx',
    rev: 1,
    scale: 2,
    sizeMB: 4.9,
    scene: 'anime',
    inputRange: 1,
    note: '渣清/重压缩表情包专用 · 2x · 强降噪去 JPEG 伪影',
  },
  {
    id: 'realcugan-se-2x-conservative',
    name: 'AI · 温和修复',
    file: '/models/realcugan-se-2x-conservative.onnx',
    rev: 1,
    scale: 2,
    sizeMB: 4.9,
    scene: 'anime',
    inputRange: 1,
    note: '较清晰原图 · 2x · 保守修复，保纹理不变色',
  },
];

export function getModel(id: string): ModelInfo {
  const m = AI_MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`未知模型: ${id}`);
  return m;
}
