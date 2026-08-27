# 本地视频画质增强器

纯浏览器端视频画质修复 / 超分工具。文件不上传，全部在本机 GPU（WebGPU）处理。

## 功能

| 模式 | 算法 | 说明 |
|---|---|---|
| 保持原分辨率 | AMD CAS | 对比度自适应锐化，3x3 邻域，去压缩模糊 |
| 2x | AMD FSR 1.0 (EASU + RCAS) | 边缘自适应空间超分 + 锐化 |
| 4x | FSR 1.0 × 两级 | 320p → 720p 级别重建 |

- 锐化强度可调（0–100%）
- 音频自动透传重编码（AAC/Opus）
- 输出标准 MP4 (H.264/VP9/AV1 自动选择)

## 运行

```bash
npm install
npm run dev        # 开发（自带自签 HTTPS，局域网可访问）
npm run build      # 构建到 dist/
npm run preview    # 预览构建产物
```

要求：Chrome / Edge 113+（需 WebGPU 支持）。

### 局域网访问

`npm run dev` 已默认 `--host` + 自签 HTTPS。其他设备访问启动时打印的
`Network: https://192.168.x.x:5173`，首次打开点"高级 → 继续前往"接受证书。
WebGPU 要求安全上下文，纯 HTTP+IP 访问会被浏览器禁用。

## 测试

```bash
# EASU gather 排序数值验证（与 AMD 参考实现位精确对照）
npm run test:unit

# 浏览器端到端测试（headless Chromium + SwiftShader WebGPU）
# 生成合成视频 → 三档缩放全管线跑通 → 回读校验尺寸/帧数/时长
npm run test:e2e
```

## 架构

```
src/
  shaders.ts   WGSL: EASU(12-tap 超分) / RCAS / CAS,统一 Uniform 布局
  gpu.ts       FrameEnhancer: 设备管理、纹理缓存、bind group 缓存、回读
  enhance.ts   mediabunny 解码 → 逐帧 GPU 处理 → WebCodecs 编码 → MP4 封装
  main.ts      UI 逻辑
```

### 关键实现细节

- **解码帧填充裁剪**：H.264 解码器输出的 `VideoFrame.codedHeight` 含 macroblock
  对齐填充（如 240 → 258）。通过 `sample.draw()` 绘制到 display 尺寸的中间画布，
  同时烘焙 rotation 元数据。
- **EASU 无 textureGather**：WGSL 的 `textureGather` 角落顺序与 AMD 参考实现
  （GLSL/D3D）不一致。改用 `textureLoad` 显式仿真 gather 四角，映射关系已由
  `tests/easu-ordering.test.mjs` 与参考实现逐像素对照验证。
- **精度**：RCAS hitMin/hitMax 与 EASU 归一化使用精确除法（AMD 参考为 ARcpF1），
  其余保留 AMD 位技巧近似（loRcp/medRcp/loRsq）。
- **资源复用**：纹理按尺寸缓存、bind group 按 (pipeline, src, dst) 缓存、单一持久
  uniform buffer（每帧 `onSubmittedWorkDone` 后才回读，写入安全）。

## 已知限制

- 不做去噪/去模糊/插帧/人脸修复（见 tapirconvert 分析中的 P2/P3 计划）
- AI 路径（IMDN ONNX）未接入，当前全部为算法级处理
- headless 环境（SwiftShader）下纹理通路不可用，输出为黑帧属环境限制，
  真实硬件不受影响
