# NovelWeaver 使用演示录制指南

成片：**1 分 37 秒 · 1920×1080 · 25 fps · 中文字幕，无旁白**。以内置原创示例《雾港纪事》展示真实界面与完整操作链路。画面持续标注 **「本地规则模式 · 示例项目」**；本次不接入外部模型，不把规则模板输出描述为模型生成效果。

[观看 / 下载 MP4](https://github.com/exuusiai/NovelWeaver/releases/download/demo-2026-10-16/NovelWeaver-demo-2026-10-16.mp4) · [GitHub Release](https://github.com/exuusiai/NovelWeaver/releases/tag/demo-2026-10-16)

| 时码 | 内容 |
|---|---|
| 00:00 | 开场 |
| 00:06 | 项目总览 |
| 00:13 | 世界设定 |
| 00:26 | 关系图谱 |
| 00:34 | 剧情工程 |
| 00:44 | 证据检索 |
| 00:53 | 写作、生成依据与采纳撤销 |
| 01:18 | 连续性审查 |
| 01:26 | 稿件导出 |
| 01:32 | 片尾 |

## 录制环境

需要 Node.js 22、pnpm 10 与项目依赖。在仓库根目录执行：

```bash
pnpm install
pnpm build
demo_data_dir=$(mktemp -d "${TMPDIR:-/tmp}/novelweaver-demo.XXXXXX")
NOVELWEAVER_DATA_DIR="$demo_data_dir" \
  DOTENV_CONFIG_PATH=/dev/null \
  AI_API_KEY='' AI_EMBEDDING_MODEL='' \
  HOST=127.0.0.1 PORT=4310 pnpm start
```

打开 `http://127.0.0.1:4310`。此实例使用独立临时数据库；首次启动自动建立《雾港纪事》，含 4 个章节、10 条正史设定、4 个事件、3 条剧情线和 2 条伏笔。现有 `.data/` 与模型配置不受影响。保留终端中的 `demo_data_dir`，重录时可继续使用同一目录；需要恢复初始状态时，重新创建一个临时目录再启动。

录制前确认：

- 使用独立浏览器会话，选中《雾港纪事》，避免残留章节选择与未保存草稿。
- 先在设置页确认「本地规则模式」，再回到总览。不要录入、展示密钥或私人项目。
- 画面采用 16:9，正文、按钮与字幕在成片中清晰可读；关闭通知和无关窗口。
- 先演练一次页面切换及生成操作；正式录制使用初始数据。每个操作后留出阅读停顿，长等待可剪短。

## 自动录制

[demo/record.mjs](demo/record.mjs) 使用 Playwright 录制实际页面，字幕、鼠标指示和片头位于独立展示外框中，应用本身不作修改。脚本会启动独立服务、创建新示例数据库，验证 Markdown 下载内容，并输出浏览器错误记录。

在 macOS 上安装 Google Chrome 后，可把录制依赖放在临时目录，避免改变项目依赖：

```bash
pnpm build
demo_tools_dir=$(mktemp -d "${TMPDIR:-/tmp}/novelweaver-tools.XXXXXX")
npm install --prefix "$demo_tools_dir" playwright
"$demo_tools_dir/node_modules/.bin/playwright" install ffmpeg
PLAYWRIGHT_MODULE="$demo_tools_dir/node_modules/playwright" \
  DEMO_OUTPUT=.data/showcase node docs/demo/record.mjs
```

默认使用 Google Chrome 的 macOS 安装路径；其他平台可设置 `CHROME_PATH`。`DEMO_PORT` 默认为 4393，端口占用时会停止。每次录制创建新的隔离数据库。输出目录包含 `recording.webm`、分镜 PNG、`captions.zh-CN.srt`、`recording.json` 与实际导出的 `exported-manuscript.md`。

MP4 / GIF 后期处理需要完整版 FFmpeg（Playwright 自带的裁剪版仅供录屏）。字幕时码从页面就绪开始；导出成片时应剪掉开头加载时间，再核对字幕。此次原始视频 98.32 秒，剪去开头 1.30 秒：

```bash
ffmpeg -ss 1.30 -i .data/showcase/recording.webm -t 97.02 \
  -vf fps=25 -c:v libx264 -preset veryfast -crf 20 \
  -pix_fmt yuv420p -movflags +faststart -an NovelWeaver-demo-2026-10-16.mp4
```

重录时根据新的 `recording.json` 和视频实际长度重新校准，不能沿用本次剪切值。发布视频已烧录字幕，SRT 是可选字幕附件。

## 分镜与字幕

精确时码以最终成片为准；写作台预留最多时间，突出「预览依据 → 真实生成 → 作者决定是否采纳」。

| 场景 | 真实界面操作 | 建议字幕 |
|---|---|---|
| 开场与总览 `/` | 显示项目名、示例梗概、章节与进度区域 | **NovelWeaver：让长篇创作有记忆、有依据。** 章节、设定与剧情集中管理。 |
| 世界设定 `/bible` | 选择林雾，再切换季岚，展示角色字段与正史状态 | 人物、地点与规则形成结构化档案。正史由作者决定。 |
| 关系图谱 `/graph` | 展示人物关系，选中节点或切换可用视图 | 用关系网络梳理人物、势力与故事联系。 |
| 剧情板 `/plot` | 展示已有剧情线、事件时间轴与伏笔状态 | 主线、支线和伏笔放在同一套故事结构中。 |
| 记忆检索 `/memory` | 检索「第七码头与林澈失踪有什么关系？」；选择结果，展示证据详情 | 检索原文与设定，每次召回都可以查看来源依据。 |
| 写作台 `/write` | 从检索证据打开第一章，切换「正文草稿」，输入要求，点击「预览生成依据」，展示上下文与预检，再点「确认并生成」；实际追加、撤销并保存 | 正文、细纲与创作 Agent 同屏协作。先看依据与预检，再生成候选草稿。**当前为本地规则模板演示。** |
| 连续性审查 `/review` | 点击「重新运行审查」，展示实际得到的提示 | 规则审查检查时间线、正史状态与伏笔，问题交给作者判断。 |
| 稿件导出 `/` | 滚动至「导出稿件」，点击 Markdown，展示下载结果 | 本地保存，支持 TXT、Markdown、DOCX、EPUB 与完整 JSON 备份。 |
| 收尾 | 回到项目总览，或使用简洁片尾 | **从设定到成稿，作者始终保留最终决定权。** |

写作台示例要求：

> 续写林雾与季岚的对话，保持当前视角，不揭露姐姐失踪的真相。

无 API Key 时，正文输出是固定的短演示文本，不会完整执行上述创作要求。保留界面中的本地模式说明，字幕也明确这一边界。若展示「采纳」，只在临时示例库执行，并录下实际保存反馈；不需要为了成片改动原项目。

## 画面与文案校验

- 种子设定原本就是正史，不能把它展示成「刚刚由 AI 自动提取并确认」；未发生的导入、分析和模型调用不作效果宣称。
- 图谱、检索结果、预检和审查提示均取自本次真实操作，不伪造命中结果或覆盖页面输出。
- 本次不展示依赖外部模型的向量检索、完整长文生成或分析指标，也不沿用旧脚本中的测试数、基准数据和其他作品内容。
- 校验导出文件确实下载并含示例正文；查看成片开头、中段、结尾，确认文字无遮挡、字幕可读、无敏感内容。

## GitHub 展示方式

成片发布为公开 GitHub Release 的 **MP4 附件**。README 顶部、概览之前放置链接到发布页的动图，并保留完整 MP4 的观看 / 下载链接。

仓库资产：`docs/demo/preview.gif` 是 18 秒、960×540 的预览，摘取图谱、检索和生成镜头；`docs/demo/cover.jpg` 是发布封面；`docs/demo/captions.zh-CN.srt` 是字幕。完整 MP4 作为 Release 附件，不放入 Git 历史。原始录屏和示例数据库留在被忽略的 `.data/` 中。

本次验证：项目生产构建通过；浏览器运行无报错；实际下载 Markdown 成功；追加再撤销后，导出仍为原始四章正文；检查 MP4 编码、关键帧、片头片尾与字幕，确认画面完整。
