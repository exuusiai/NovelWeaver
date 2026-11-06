# NovelWeaver Harness 本机阶段交接

本轮已形成“任务定义 → 检索与上下文 → 原文核对 → 局部补丁 → 分层检查 → 作者采纳 → 历史与记忆更新”的可运行链路。固定工作流负责第一版业务，工具注册表和策略接口用于后续服务器模型联调。离线验收使用原创合成故事、确定性 mock 和内存 SQLite。

验收日期：2026-11-06（Asia/Shanghai）。改造起点：`480c578c0f642cb1d4b2813f6b7d59497978a930`。

## 服务器先执行

使用 Node 22.x、pnpm 10.15.1，从仓库根目录执行：

```bash
git fetch origin
git switch --track origin/codex/novelweaver-harness-local
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
NOVELWEAVER_DATA_DIR=:memory: AI_API_KEY= pnpm eval
pnpm eval:harness
pnpm build
cp .env.server.example .env
pnpm start
```

已在临时全新目录使用 **Node 22.21.0 / pnpm 10.15.1** 验证锁文件安装、原生 SQLite 构建、测试、评测和生产构建。`pnpm-workspace.yaml` 修正了原生依赖构建许可的占位值，允许 `better-sqlite3` 和 `esbuild` 安装脚本。

开发启动：`pnpm dev`（前端 5173、API 4300）。生产启动：`pnpm build && pnpm start`。配置示例使用相对数据路径 `./.data/server`，默认监听 `127.0.0.1`。接入外部访问前由服务器阶段配置鉴权与反向代理。

## 代码入口与交付功能

| 入口 | 职责 |
|---|---|
| `server/harness/protocol.ts` | 工具注册、错误、成本、任务、补丁、检查和运行类型；`ToolPolicy` 在 executor 中预留 |
| `server/harness/schemas.ts` | Zod 输入输出、运行、观察、快照和 JSONL Schema |
| `server/harness/executor.ts` | 预算、条件路由、有限重试、超时、取消、暂停恢复、调用意图和中断恢复 |
| `server/harness/workflows.ts` | `revision.local@1.0.0` 固定工作流；检索为空时一次补查；停在作者采纳前 |
| `server/harness/tools.ts` | 改稿工具、显式正史确认、作用范围、依赖、影响分析和压缩 |
| `server/harness/adapters.ts` | 可替换生成器、语义检查器、压缩器；默认接现有 OpenAI 兼容网关 |
| `server/harness/evidence.ts` | 稳定证据 ID、精确原文位置、版本验证和来源绑定 |
| `server/harness/store.ts` | 持久化运行、相关数据库快照、隔离恢复、观察回放和 JSONL 导出 |
| `server/provenance.ts` | 统一来源版本、实体身份、章节/卷、受众、角色知情与故事时间过滤 |
| `server/context-selection.ts` | `setting.select` 与整条目预算打包，列出入选、排除、裁剪和诊断 |
| `server/memory.ts` | 复用原词法/向量检索；修复跨项目及 full/upto 缓存键；旧生成入口共用新选择器 |
| `server/review.ts` | 完全一致、明确不同、待语义核验三类事实比较；按身份、信念持有者和时间区间区分口径 |
| `server/routes/helpers.ts` / `chapters.ts` | 共享历史与检索记忆重建；编辑、历史恢复和 Harness 采纳均遵守版本与失效规则 |
| `server/routes/analysis-service.ts` | 抽取结果绑定源稿；源稿在调用期间变化时跳过聚合结果；同名歧义不自动归并/连关系 |
| `server/routes/harness.ts` | REST 路由与标准错误响应 |
| `src/components/HarnessPanel.tsx` | 修改目标、全章/选区、视角身份、故事时间、保留项、差异、检查、采纳/拒绝/撤销、轨迹 |
| `src/components/DiffView.tsx` | 从历史面板抽出的共享段落差异展示 |
| `eval/fixtures/harness/story.json` | 原创《雾灯案》合成故事、任务、预期文本对和数据划分 |
| `eval/harness-scenarios.ts` / `server/harness-api.test.ts` | 合成场景和 HTTP/历史恢复验收 |

写作页右栏“一键润色与局部改稿”可直接使用。未配置生成器时显示“等待检查”，可填作者候选继续。候选的每个补丁有原文、候选和理由；部分采纳先检查所选组合。程序失败或模型判定失败会阻止采纳；语义为 pending 时，作者勾选确认后可采纳。作者评分与备注单独记录，程序通过不会自动变为创作质量通过。

## 工具协议

Schema 版本：`novelweaver.harness.v1`。机器可读完整契约在 [`harness-schemas.json`](harness-schemas.json)，重建命令：

```bash
pnpm harness:schemas
```

注册信息包含 `name / version / source / effect / inputSchema / outputSchema`。effect 分为 read、generate、write；read 工具可以登记可追溯证据，业务正文和正史写入由 write 工具负责。执行结果包含 `status / output / error / changes / costs`。每次尝试记录参数、工具版本、开始时间、观察、执行前后状态指纹和成本。

| 工具 | 输入要点 | 输出/行为 |
|---|---|---|
| `task.define` | chapterId、baseRevision、goal、range、pov/holderId、storyTick、targetWords、preserve、allowedChanges、evidenceIds | 结构化任务；同名视角未指定 holderId 时停为 NEEDS_CHECK |
| `memory.search` | query、limit、view | 基于现有 searchMemory 的稳定证据、位置、来源版本和检索依据 |
| `setting.select` | query、view | 所有类型共用作用范围与来源过滤，返回入选与排除原因 |
| `context.pack` | tokenBudget | 使用本次 selection，整条目打包，返回实际入选证据与预算报告 |
| `evidence.read` | evidenceIds、可选 location | 按 ID/范围读取原文并验证版本；空证据返回 pending |
| `revision.plan` | 本次任务状态 | 目标、范围、允许变更、保留项、原文与证据 |
| `revision.propose` | 可选 manualReplacement、rationale | 适配器或作者候选；精确位置补丁；未配置适配器返回 pending |
| `revision.verify` | 可选 patchIds | 程序检查与四项语义判断分别记录 |
| `revision.commit` | baseRevision、idempotencyKey、candidateId、patchIds、acknowledgePending、authorEvaluation | 事务内校验、历史、正文、摘要失效、记忆重建与幂等回执 |
| `revision.reject` | baseRevision、idempotencyKey、reason | 记录作者拒绝 |
| `revision.undo` | baseRevision、idempotencyKey | 正文仍为采纳版本时撤销；正文已继续变化则冲突 |
| `memory.scope` | baseRevision、idempotencyKey、kind、itemId、metadata | 作者显式调整可见性；不重新认证失效的正史来源 |
| `canon.confirm` | baseRevision、idempotencyKey、kind、itemId、sourceChapterIds、sourceRevisions、note | 作者确认正史并绑定已复核的当前源稿版本 |
| `dependency.link` | baseRevision、idempotencyKey、sourceKind/sourceId、targetChapterId、relation、evidenceIds | 作者登记明确跨章依赖 |
| `impact.analyze` | chapterId | 显式依赖及伏笔 setup/payoff 为 certain；共享事件参与者为 needs_review |
| `memory.compact` | tokenBudget、view、useCompressor | 确定性打包状态/目标/因果/伏笔及来源；可替换压缩器；缺压缩器则 pending |

写操作统一要求正整数 `baseRevision` 和至少 8 字符的 `idempotencyKey`。回执以 project + key 唯一，同 key 的工具、运行或参数不同返回 IDEMPOTENCY_CONFLICT。重复相同采纳返回原结果，正文、历史和采纳记录各保留一次。

位置采用 JavaScript **UTF-16 下标**，区间 `[start,end)`；候选必须逐字匹配原文、位于任务范围且互不重叠。targetWords 的程序检查为结果全章字符长度不超过目标 130%，语义篇幅适配留给生成器。

标准错误：INVALID_INPUT、INVALID_OUTPUT、NOT_FOUND、VERSION_CONFLICT、STALE_EVIDENCE、IDEMPOTENCY_CONFLICT、TEMPORARY_FAILURE、TIMEOUT、CANCELED、BUDGET_EXHAUSTED、NEEDS_CHECK、VERIFICATION_FAILED、INTERNAL_ERROR。只有显式可重试错误进入有限重试；write 超时不自动重试。预算默认 24 次调用、40k 估算 Token、单次 30 秒、1 次重试、单次输出上限 3000 Token。

Token 成本优先使用服务商 usage，其余标记 estimated；金额未知时为 null。模型调用前估算输入并预留输出，服务商输出有 max_tokens 限制。实际 usage 超出估算预算时记录后停止；准确计费和分词校准在服务器阶段完成。

## 记忆、知识和版本规则

`chapters.revision` 单调递增，恢复旧正文也产生新版本。章节正文、标题、摘要、视角、位置、故事刻度变更会推进版本；绑定的派生记录保守失效。迁移旧库时，已有 content_hash/analyzed_hash 明确显示过期的来源直接标记 stale。`source_bindings` 保留 kind/item/chapter/source_revision 与 current/stale/missing 状态；原先的 canon_status 保留作者决定，stale 只控制来源有效性和上下文使用。

正文采纳或编辑后：旧章节摘要清空，原文检索块重建，旧抽取事实/事件/人物来源过期并从上下文排除。历史恢复使用历史摘要（包括空摘要），恢复细纲（包括空细纲），重建正文记忆；结构化抽取结果等待重分析或作者 `canon.confirm`。异步摘要生成写回前也校验其读取的版本。

`memory_scopes.metadata` 使用相同字段管理卡片、关系、事实、事件、摘要与原文：

```json
{
  "audience": "belief",
  "holderId": "character-id",
  "entityIds": ["character-id"],
  "knownBy": ["character-id"],
  "chapterIds": ["chapter-id"],
  "validFromTick": 10,
  "validToTick": 20,
  "tags": ["state", "goal", "causality", "foreshadowing"]
}
```

- audience：world 世界事实、belief 指定角色信念、reader 读者知情、author 作者计划。角色信念不会并入世界事实冲突组。
- view：author / reader / character，character 可指定 holderId、entityIds、storyTick。knownBy 用稳定人物 ID；同名人物各用独立 ID。
- narrative position 与 story_tick 分开；两者都满足才进入角色上下文。倒叙由显式整数刻度控制，自定义历法文本不会被程序猜成可靠顺序。
- 未给故事刻度时，报告 `story_time_unset:narrative_order_only`；未指定视角身份时报告 character_identity_unset。无来源的旧聚合卡/关系在角色视角排除。
- 旧卡片 data 中的卷/附近章节/manual 作用范围继续生效；旧标题锚点有歧义时报告 legacy_scope_unresolved。manual 卡片需 view.manualIds 显式选择。pinned 不绕过作用范围。
- 关系必须同时通过两端人物作用范围；planned 事件作为作者计划过滤。旧生成入口共享新选择器，full 模式保留作者规划，upto 模式限制后文信息。

证据 ID 由项目、源记录/章节、版本、位置和来源绑定确定。原文改动、恢复或来源失效后，旧引用读取返回 STALE_EVIDENCE。新检索块保留正文内部空白以维持原文定位；旧检索块若经规范化而无法定位，则排除为 unlocated_chunk，不伪造偏移。上下文整条目裁剪，报告 token_budget，避免截断引用改变命题。

事实完全一致才自动兼容；字符串包含关系记为 fact-support-pending，否定/对象变化进入差异检查。显式不重叠的时间区间、不同实体身份或不同信念持有者分别比较。更细的自然语言蕴含关系由语义检查器处理。

## REST、轨迹、快照与回放

```text
GET  /api/harness/tools
POST /api/harness/runs
GET  /api/harness/runs/:runId
POST /api/harness/runs/:runId/control       {action: pause|resume|cancel}
POST /api/harness/runs/:runId/call          {tool, input}
POST /api/harness/runs/:runId/snapshots
GET  /api/harness/snapshots/:snapshotId/replay
GET  /api/harness/runs/:runId/export        application/x-ndjson
GET  /api/projects/:projectId/harness/runs
```

创建运行返回 202，后台执行；调用工具返回 Observation，工具内部错误以 status=error 表达。HTTP 请求体错误返回 400 + INVALID_INPUT；资源/版本错误返回对应 404/409。开始采纳前先检查所选 patchIds，采纳请求不能提交任意替代候选或伪造检查结果。

运行持久化到 harness_runs，包含任务/工作流/模型版本、完整交互历史、步骤、重试、成本、停止原因、候选、检查和采纳。执行前持久化 pendingCall；重启后补入中断观察，保留已消耗预算并暂停。写操作中断后的结果可通过原幂等键恢复。

快照包括项目文档、章节历史、相关结构化数据库、检索块、证据、作用范围、回执、交互、工作流游标、剩余预算及确定性随机状态。FTS 由正文块重建。HTTP 回放仅返回已记录观察；数据库恢复入口只在内存或显式隔离环境可用。

将 snapshot API 返回结果保存为 snapshot.json 后：

```bash
pnpm harness:replay snapshot.json
pnpm harness:replay snapshot.json --resume
```

第一条生成观察回放，第二条在内存库恢复后继续固定工作流；两者强制禁用网络模型，输出到 `.data/harness-replay/replay.json`。可用 `--out <目录>` 指定输出。

每行 JSONL 包含 taskId、sourceFamilyId、split、schemaVersion、dataOrigin、initialState、goal、constraints、steps、outcome、costs、verification、adoption，另带工作流/模型版本、interaction 和 randomState。合成数据为 synthetic，作者操作默认为 author。训练划分按 sourceFamilyId 成组，作者项目先补充稳定 family ID，再划分 train/validation/test；本轮合成故事固定在 test，保留为验收集。

## 模型适配

默认 Harness 语义适配器需同时满足：HARNESS_MODEL_ENABLED=1、NOVELWEAVER_OFFLINE!=1、现有网关已配置 API Key。在 `.env` 中填写 AI_BASE_URL、AI_MODEL、AI_API_KEY，再显式启用 Harness。密钥不写入工具参数、轨迹或配置示例。

Generator.propose 和 SemanticChecker.verify 独立注入 `createRegistry(adapters)`。服务端可分别替换模型、提示词和版本；返回 usage 可记录真实输入/输出 Token。四项语义检查名固定为 goal_repair、fact_preservation、unsupported_additions、pov。缺失、重复、越界或失效引用的检查项均保留 pending。fixture 适配器只由 eval 依赖注入，HTTP 默认适配器不能从环境变量切换成 fixture。

Compressor.compact 接收文本、证据 ID 和预算，返回文本与保留 ID。执行器校验预算及引用集合；压缩内容的语义保持需在真实模型阶段另测。确定性打包优先保留带 state/goal/causality/foreshadowing 标签的条目，预算不足时明确列出未入选项。

## 基线、验收与问题清单

基线（改造前）：81 passed、4 skipped；构建通过。最初本机 pnpm 11 的自动依赖检查被构建许可占位值阻断；直接本地依赖运行确认基线，最终按声明的 pnpm 10 完成全新安装验收。

最终结果与逐项场景见 [`local-acceptance.json`](local-acceptance.json)。`pnpm test` 默认内存数据库、空 API Key，并阻止未 mock 的外部网络；门控向量测试使用 mock fetch。`pnpm eval:harness` 自建内存数据、禁用网络、写报告和 JSONL 到 `.data/harness-eval/`。

离线场景覆盖同名隔离、未来秘密、倒叙和重排、旧派生信息与引用、润色与事实保持、证据不足/未配置语义检查、冲突、有限恢复、幂等、撤销与历史恢复、部分采纳、快照与随机状态、预算/取消、影响与压缩、否定/对象/时间变化、显式正史确认、Schema 拒绝、中断恢复、语义漏检和一次补查。

已修复的验收失败：摘要引用缺来源版本；下载附件覆盖 JSONL MIME；空历史细纲未恢复；异步摘要可能写回旧稿；旧检索缓存混用 full/upto；同名映射覆盖人物身份；重分析可能错误重绑其他候选关系。保留的失败行为均有明确错误或 pending：旧补丁、失效证据、不同请求复用幂等键、无限暂时失败、未知语义、缺检查项、预算耗尽和来源不足。

服务器阶段应完成：

1. 接入真实生成器和独立语义检查器，检查 UTF-16 定位、JSON 合法率、重试、超时、usage 与费用；保留适配器/提示词/模型精确版本。
2. 用新增 sourceFamily 的保留集衡量目标修复、事实保持、无依据新增、角色知识边界和作者盲评。固定文本对 mock 的通过率用于工程验收，真实语义支持与创作质量单独测量。
3. 将模型实体/关系的聚合来源细化到实际章节和原文位置。当前聚合结果绑定本批全部源章；无精确来源的旧聚合卡在角色上下文保守排除。作者可复核并明确重绑正史来源。
4. 补足角色知情、秘密揭示位置、故事时间刻度和不同时间的事实区间。当前程序验证显式元数据；章内场景知情传播、隐含因果和自然语言历法仍需模型/作者复核。
5. 评估语义 impact 召回/误报与压缩事实保持率。certain 表示显式结构关联，不能直接解释为该章正文一定要改；共享参与者仅进入待核查清单。
6. 用真实长篇压测选择器、轨迹/快照体积、恢复耗时和预算估计，建立保留/归档策略；校准供应商计费与服务端分词。
7. 在固定工作流基线通过后实现 ToolPolicy.chooseNext，执行器继续约束预算、Schema 和作者写入操作；增加多用户鉴权、并发作业锁与部署监控后再开放服务。

个人数据库、私有文稿、凭证、评测运行输出和模型权重均由 .gitignore 排除。本轮提交只包含代码、配置空模板、文档和原创合成 fixture。
