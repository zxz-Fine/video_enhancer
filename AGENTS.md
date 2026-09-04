# 项目约定

## 提交纪律

- 每次修改完代码后，必须向本目录的本地 git 仓库 commit（约定式提交信息，中文或英文均可）
- 不要推送远程（本地仓库，用户自行管理）
- `test_video/` 内含用户私人测试视频，永远不要提交或外传

## 测试

- 修改着色器/AI 管线后运行：`npm run test:unit`（算法数值）、`npm run test:e2e`（浏览器端到端）
  - 日常迭代用 `npm run test:e2e:fast`（跳过 FSR4x/keepRes 分块/RIFE x4 三个最慢用例，约 3 分钟；全量后台跑）
  - UI 改动用 `npm run test:smoke`（id 存在性 + 预设联动 + 三模式截图，约 30 秒）
- 新接入 AI 模型时必须跑 `tests/probe-model.mjs` 式灰色恒等探针确认输入范围约定（0-1 或 0-255，各模型不同）

## 已知模型约定

| 模型 | 输入范围 | 倍数 |
|---|---|---|
| imdn-x2 | 0-255 | 2x |
| realesr-general-x4v3 | 0-1 | 4x |
| realesr-animevideov3 | 0-1 | 4x |
| realesrgan-anime6b-x4 | 0-1 | 4x |
| realcugan-se-2x-denoise3 | 0-1 | 2x |
| realcugan-se-2x-conservative | 0-1 | 2x |

- 模型对奇数尺寸输入会 +2 padding，输出必须按张量真实 dims 处理后再缩放
- fp16 变体必须用 `onnxconverter_common.float16.convert_float_to_float16(keep_io_types=True)` 生成（补 Cast 边界）；手改 initializer dtype 会导致 Conv 内外精度混杂，WebGPU EP 建会话失败回退 CPU
- ONNX 动态轴：输出 H/W 的 dim_param 必须与输入不同名（如 `height_x4`/`width_x4`）；同名会被 WebGPU EP 当等尺寸复用缓冲，run 时 Shape mismatch 抛错（wasm EP 不报错，会漏检）
- 大参数模型设 `ModelInfo.tile` 调小分块（如 anime6b 384，默认 768），否则单块 OOM；模型输出超 4K 时 `processCanvas` 会限幅前置缩输入（视觉等价，省内存/算量）

## 用户环境

- 开发在 Linux 服务器（samba 共享），使用浏览器的是局域网 Windows 设备（Intel UHD 730 / GTX 1650）
- headless 测试走 wasm EP + allowBlackFrames；真实画质以用户实测为准
- npm 安装慢时用代理：`export http_proxy=http://192.168.1.26:7890 https_proxy=$http_proxy`，或 npmmirror registry
