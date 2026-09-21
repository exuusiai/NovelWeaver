# NovelWeaver

本地优先的小说创作 Agent 工作台。当前版本已经打通项目创建、文稿导入、设定维护、剧情工程、章节写作、记忆检索、关系图、连续性审查、导出和 OpenAI 兼容模型接入。

## 启动

本机使用 Codex bundled Node 时：

```bash
export PATH="/Users/adnachiel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/adnachiel/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH"
pnpm install
pnpm dev
```

打开 <http://localhost:5173>。开发服务器会把 `/api` 代理到 `http://localhost:4300`。

常用命令：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

`pnpm start` 会从 `dist/` 提供生产版页面，使用 `http://localhost:4300`。

## 模型 API

没有 API Key 时，系统使用 `local-rules-v1`。它是确定性的规则与模板，不是隐藏的小语言模型。数据管理、导入、搜索、图谱和规则审查仍可使用，但系统不会用正则猜测人物或地点；文稿会明确标为“待模型分析”。

接入 OpenAI 兼容 API 有两种方式：

1. 在“设置 → 模型网关”中输入 Base URL、模型名和临时 Key。Key 只保存在当前服务进程内。
2. 复制 `.env.example` 的配置到运行环境，通过 `AI_BASE_URL`、`AI_API_KEY` 和 `AI_MODEL` 注入。

项目会自动加载根目录的 `.env`。例如使用米醋 API：

```env
AI_BASE_URL=https://www.micuapi.ai/v1
AI_API_KEY=你的密钥
AI_MODEL=deepseek-v4-flash
```

Base URL 只需填写到 `/v1`，不要附加 `/chat/completions`；即使误填，系统也会自动规范化。设置页的“保存并测试”会立即发出最小请求，只有验证成功才显示“连接已验证”。仅填写 Key 不等于模型可用：`401` 通常表示密钥错误，`403` 表示无模型权限，`429` 表示额度或限流，`model_not_found` 表示密钥所属分组没有该模型渠道，`5xx` 表示供应商渠道暂不可用。

## 已实现模块

- 从零创建项目，以及 TXT、Markdown、DOCX、EPUB、PDF 文稿导入；
- OPF 阅读顺序、目录去重、空章过滤、PDF 页码清理、章节识别、段落整理和切片索引；
- 模型驱动的实体消歧、事件提取、关系提取和剧情线归纳，所有结果先进入候选；
- 人物、地点、势力、力量体系、物品、世界和术语各自独立的详细档案字段；
- 正史、候选、传闻、分支、废弃状态；
- 剧情线、事件时间轴、状态看板、伏笔生命周期；
- 总纲、单章细纲、正文草稿和设定候选生成；
- 三栏章节工作台、可折叠/固定的左右侧栏与生成结果逐步采纳；
- 分层记忆、证据检索、上下文组装和生成快照；
- 人物、势力、地点、事件因果与伏笔网络五种独立图谱；
- 章节结构、视角、时间、事件参与者、候选正史和伏笔检查；
- 项目 JSON 全量备份；
- 无密钥本地模式与 OpenAI 兼容 API 模式。

## 数据

SQLite 数据库位于 `.data/novelweaver.db`，已被 `.gitignore` 排除。首次运行会创建“雾港纪事”示例项目，用于展示全部页面和数据关系。

数据表和模块边界见 [架构说明](docs/ARCHITECTURE.md)。产品规划见 [小说创作 Agent 产品与技术规划报告](小说创作Agent产品与技术规划报告.md)。

## 当前边界

- 本地检索使用精确文本、关键词与重要度排序；数据库已为后续 Embedding 字段与重排器预留边界，收到 API 后可接入真实向量检索。
- 无模型时不执行专名抽取；模型分析结果一律进入“候选”，确认前不会进入正史图谱。
- API Key 的 UI 配置刻意不持久化。生产部署应使用环境变量或系统密钥服务。
- 多人实时协作、权限系统和发布平台自动同步不属于当前单机版本。
