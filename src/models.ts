export interface ModelInfo {
  id: string;
  name: string;
  file: string;
  scale: 2 | 4;
  sizeMB: number;
  scene: 'general' | 'anime';
  /** 模型期望的像素输入范围：255 或 1 */
  inputRange: 255 | 1;
  note: string;
}

export const AI_MODELS: ModelInfo[] = [
  {
    id: 'imdn-x2',
    name: 'AI · 极速增强',
    file: '/models/imdn-x2.onnx',
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
    scale: 4,
    sizeMB: 2.4,
    scene: 'anime',
    inputRange: 1,
    note: '动漫/手绘/插画视频专用 · 4x · XS 轻量，时域稳定，替代旧 anime6b 图片模型',
  },
];

export function getModel(id: string): ModelInfo {
  const m = AI_MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`未知模型: ${id}`);
  return m;
}
