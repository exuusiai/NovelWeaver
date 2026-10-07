# NovelWeaver 架构说明

## 设计原则

1. 原文是证据，结构化数据是可编辑的正史视图，两者互相引用但不互相替代。
2. AI 输出默认是候选；所有正史变更必须经过显式业务操作。
3. 检索、上下文组装、模型调用和写回分层，模型供应商不能渗透到业务模块。
4. 当前使用模块化单体，保持未来拆分异步任务和独立检索服务的边界。

## 运行结构

```text
React Workbench (Vite)
        │ /api
        ▼
Express Application
  ├─ Project / Chapter API
  ├─ Canon & Plot API
  ├─ Import Pipeline
  ├─ Structured Manuscript Analyzer
  ├─ Narrative Memory
  ├─ Continuity Review
  └─ Model Gateway
        │
        ▼
SQLite + FTS5      OpenAI-compatible API (optional)
```

## 后端模块

- `server/index.ts`：应用装配、路由挂载、静态资源与生产入口；路由实现位于 `server/routes/`。
- `server/routes/`：按域拆分的路由——`projects`（项目/模型/审查/导出/备份）、`chapters`（章节/卷/历史/预检/摘要重写）、`world`（实体/事实/关系）、`story`（大纲/拆分/剧情线/事件/伏笔）、`ingest`（导入/分析任务）、`generate`（AI 上下文与流式生成），共享逻辑在 `helpers`，任务调度在 `analysis-service`。
- `server/db.ts`：数据库初始化、演示数据和最小数据访问层（`NOVELWEAVER_DATA_DIR=:memory:` 用于测试）。
- `server/importer.ts`：文件解析、EPUB spine 排序、目录去重、空章过滤、版式整理、章节切分、分块与摘要。
- `server/analyzer.ts`：模型结构化抽取、实体别名合并、事件、关系与剧情线分析。
- `server/memory.ts`：项目内检索、人物状态推演与任务上下文组装。
- `server/ai.ts`：本地规则引擎和远程模型网关。
- `server/review.ts`：可解释的连续性规则检查与单章生成前预检。
- `server/exporter.ts`：TXT / Markdown / DOCX / EPUB 稿件构建。
- `server/backup.ts` + `server/project-export.ts`：全量快照、保留策略与调度。

## 关键数据对象

- `projects`：作品或共享世界观的顶层空间。
- `chapters`：有序章节、正文、视角、摘要和状态。
- `entities`：人物、地点、势力、体系等统一实体；`data` 保存题材自定义字段。
- `plotlines` / `events`：剧情线与故事事件，分别保存故事时间和叙事顺序。
- `relations`：有时间边界、方向、强度与情感倾向的实体关系。
- `foreshadowing`：伏笔的埋设、强化、回收状态。
- `memory_chunks` / `memory_fts`：可引用的原文或设定记忆及全文索引。
- `reviews`：审查问题与用户裁决状态。
- `generations`：任务、上下文快照、模型版本与输出。
- `imports`：原始导入文本、文件哈希和解析诊断，用于防重与可恢复重分析。
- `analysis_runs`：分析模型、结果计数和运行状态。

## 模型接入点

`generate()` 先调用 `assembleContext()`，得到当前章、剧情线、正史实体、近期事件和检索证据。模型只能消费这一快照，不能直接修改数据库。响应包含引用片段；用户采纳正文后，章节保存流程才会重建相关记忆。

Embedding 升级路线（对照实验结论见 `eval/reports/`）：

1. ✅ 为 `memory_chunks` 写入向量并后台增量回填（未配置 / 覆盖率不足 / 接口失败时静默回落词法）；
2. ✅ 查询形态门控召回：含已知实体名的查询走词法混合，改述类查询走向量语义召回（对照实验表明并行 RRF 融合反而劣化，故未采用）；
3. ✅ 建立固定检索测试集，监测 Recall@K、MRR 和无关 Token 比例（`eval/` 金标准 + 基线 + 回归门）；
4. ⬜ 重排模型对候选块统一评分（当前 Top-8 疑似噪声率约 34%，是下一阶段的精度优化点）；
5. ⬜ 增加"候选事实差异"提取器，写入审核队列而非直接更新实体。

## 事务与可恢复性

文稿导入在单个 SQLite 事务中建立章节、原始导入记录和记忆。模型可用时，导入完成后分批执行结构化分析，候选实体、事件、关系和剧情线在事务中写入。替换导入只删除旧的导入章节与模型候选，保留手写章节和正史条目。章节正文更新会删除该章旧索引并局部重建。项目导出包含全部核心创作数据，不包含运行时 API Key。
