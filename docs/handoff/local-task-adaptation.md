# NovelWeaver 本地任务适配交接

交付分支：`codex/novelweaver-task-adaptation-local`。改造基线：`3988addcb020861e9f9e6c0368e3ef8e0a58fb1d`。本机验收日期：2026-11-06，Asia/Shanghai。最终交付提交 SHA 见交付回复和 Git 分支 HEAD。

本轮实现按任务选择上下文、工具、执行流程、模型角色、输出契约与检查标准。七类任务共享原 Harness，另保留旧 analysis 的通用分析配置。局部改稿完成策略循环和候选修订，服务器可以直接接入真实策略与语义适配器。

本轮未调用付费模型、未下载权重、未启动 SFT 或 RL。离线模型产物来自显式注入的合成 fixture；自然语言质量和真实模型成功率待服务器联调验证。

## 代码入口

| 入口 | 职责 |
|---|---|
| server/tasks/contracts.ts | TaskInput、TaskSpec、ExecutionPlan 和分类产物契约 |
| server/tasks/resolve.ts | 显式操作优先、旧入口映射、规则理由、缺项、范围与分段预算 |
| server/tasks/profiles.ts | 七类任务与通用分析的版本化目录 |
| server/tasks/tools.ts | 上下文、分段计划、只读规则审查、产物生成与分层验证、终止动作 |
| server/tasks/service.ts | 默认任务执行器；同步/SSE 共用的生成服务 |
| server/tasks/environment.ts | 隔离项目克隆、reset/step/observe/snapshot/restore/evaluate |
| server/harness/executor.ts | 任务计划校验、工具许可、策略循环、成本、超时和恢复 |
| server/harness/tools.ts | 直接补丁输入、候选父链、预览、候选检查失效、事实得失反馈 |
| server/harness/adapters.ts | planner/writer/reviewer/extractor/answerer、改稿生成和检查接口 |
| server/routes/tasks.ts | 任务解析、配置/能力、运行、受限动作、观察与导出 API |
| src/components/TaskPanel.tsx | 任务入口、计划预览、状态、候选和可展开轨迹 |
| src/components/HarnessPanel.tsx | 既有作者采纳/拒绝/撤销；新任务显式进入 revise |
| eval/task-scenarios.ts | 30 项真实执行的合成工程场景；fixture 不进入生产适配器 |
| server/tasks-api.test.ts、server/tasks-bridge.test.ts | HTTP、约束、跨进程与文本保真检查 |

## 实际任务差异

| 配置 | 证据与执行 | 输出与写入 |
|---|---|---|
| planning | 作者视角、有效设定和明确标记的作者计划，规划角色 | 大纲/细纲/设定/剧情候选，不自动确认正史 |
| draft.standalone | 独立故事采用轻量输入；绑定章节的项目场景读取少量有效设定 | 草稿候选，不自动改正文 |
| draft.continuation | 前文状态、当前源稿和细纲；根据目标长度规划分段 | 分段累积后统一检查连续性、事实和视角 |
| revision.local | 固定选区与版本、证据、补丁、检查和必要时重改 | 当前候选绑定检查，作者显式采纳；复用历史和记忆更新 |
| review.consistency | 授权审稿上下文、只读规则和显式依赖 | 带证据/位置的问题清单，禁止正文或正史写入 |
| analysis.structure | 版本绑定的精确源稿；场景覆盖和事件对齐 | 结构化候选，不自动写入抽取正史 |
| project.qa | 相应知情/时间范围的检索证据 | 引用式回答或证据不足状态 |

作品规模不会覆盖操作目的。长篇中改一句话仍用局部改稿；短输入要求长产物按目标长度分段；长输入要求短分析仍保持只读。群像、单元式和开放结局作为创作意图传给生成与检查角色。

规则路由返回匹配原因，不输出伪造的模型概率。缺少关键目的、源稿或同名人物身份时返回 needs_input。模型角色可以共用一个服务；首轮不要求多模型同时占用 GPU。

## 契约与兼容

任务 Schema 为 `novelweaver.tasks.v1`，路由为 `rules.1.0.0`，各 profile 为 `1.0.0`。机器契约在 task-profiles.json 和 task-schemas.json，重建命令为 `pnpm tasks:schemas`。原 Harness v1 增加可选 adaptation 元数据与候选父链字段，旧运行仍可读取；新运行保留 planHash 和完整配置版本。

旧 task 标签仍支持 chat/outline/chapter_outline/prose/setting/plot/analysis；analysis 保持通用分析语义。同步与 SSE 调用同一个任务执行器。SSE 当前缓冲完整产物后发送 delta/done，让两种入口共享格式和检查；尚未提供逐 Token 传输。服务商实时流式适配可在保持同一执行计划的前提下补充。

targetWords 兼容旧字符数语义；新请求使用 targetLength 的 characters/tokens 单位。目标篇幅与上下文 Token 预算独立。打包保留硬约束并整条目裁剪，精确源稿超出容量时暂停，不能把部分源稿作为完整覆盖检查。超长结构提取需服务器增加显式分块/合并协议；现有任务不静默截断。

TaskSpec、路由结果、profile、计划、能力快照和检查标准进入运行、快照与 JSONL。工具许可在执行层验证；策略不能修改任务、扩大知情范围或调用作者写入。策略观察不包含初始数据库快照与隐藏评分配置。reset/restore/evaluate 只供环境管理。

## 本机验收

使用 Node 22.21.0、pnpm 10.15.1。原基线为 104 passed、4 skipped，构建通过；切换 Node 后重新构建了本机 SQLite 原生依赖。当前具体测试数量、命令和指标见 local-task-adaptation-acceptance.json。

    pnpm install --frozen-lockfile
    pnpm typecheck
    pnpm test
    NOVELWEAVER_DATA_DIR=:memory: NOVELWEAVER_OFFLINE=1 AI_API_KEY= pnpm eval
    pnpm eval:harness
    pnpm eval:tasks
    pnpm harness:schemas
    pnpm tasks:schemas
    pnpm build

测试与离线评测使用内存数据库，阻断未 mock 的外部调用。eval:tasks 输出到 `.data/task-eval/`，包含按场景报告与 JSONL。合成故事 sourceFamilyId 为 synthetic-foglamp-01，固定 test，用于工程回归；真实模型训练需另建来源分组的数据。

fixture 证明路由后的实际证据、工具、状态、输出结构和错误处理；程序引用检查只证明 ID/位置/版本，不代替语义支持。缺语义检查器时返回 pending，即使程序检查通过也不自动标记质量通过。独立环境 evaluate 默认 unscored，服务器必须注入独立评分器。

## 策略与模型接入

`createRegistry(adapters)` 支持注入现有 Generator/SemanticChecker，以及 artifacts.generators 的角色映射和 artifacts.checker。默认角色共用现有兼容网关；独立角色模型或端点通过相同适配器接口注入。服务端实际语义质量需要新数据校准。

改稿模型需同时启用 HARNESS_MODEL_ENABLED=1、NOVELWEAVER_OFFLINE=0，配置现有 AI_BASE_URL/AI_MODEL/AI_API_KEY。通用任务角色沿用旧生成入口的网关可用状态并遵守 NOVELWEAVER_OFFLINE。缺能力时返回待配置，不生成可误采纳的演示稿。旧 local-rules-v1 模型标签为兼容保留，executionStatus=pending 表明没有真实模型产物。

接入策略时创建带 operation=revise 的运行，并调用 `executor.runPolicy(runId, policy)`。policy 包含 version、modelVersion 和 chooseNext(observation,catalog,{signal})。返回 `{tool,input,usage?}` 或 `{stopReason,usage?}`；后者仅表示暂停，不能直接证明成功。策略直接提交 patches；采样 Token 与工具观察在训练端分别处理。本轮只用 scripted policy 验证了失败反馈、重改和停止，未连接真实策略模型。

H0/H1 反馈由 feedbackMode=summary/fact_diff 选择，进入 planHash；底层事实诊断相同。逐字项有程序前后比较，语义约束另需 constraint:ID 检查，缺少时保留 pending；未知的修改前语义覆盖不伪造成事实得失标签。

## 环境桥接

运行 `pnpm tasks:bridge`，通过 stdin/stdout 每行一个 JSON。启动的是离线内存环境，无 GPU 或训练依赖。reset 请求传入 source snapshot 与任务：

    {"id":1,"method":"reset","initialState":{"projectId":"...","tables":{}},"task":{"projectId":"...","operation":"revise","goal":"...","chapterId":"..."}}
    {"id":2,"method":"observe"}
    {"id":3,"method":"step","action":{"tool":"revision.propose","input":{"patches":[]}}}
    {"id":4,"method":"snapshot"}
    {"id":5,"method":"restore","snapshot":{}}
    {"id":6,"method":"evaluate"}

上例仅展示消息格式，source snapshot、patches 和 snapshot 必须填入实际有效内容。响应为 `{id,result}` 或 `{id,error}`。reset 克隆项目/实体 ID、正文和相关表，保留来源族与原文空白；不同 episode 的状态和缓存不共享。restore 只恢复同一环境的快照；另一个分支需独立 reset。跨进程协议已在自动测试中实测。

## 服务器下一步

从本轮分支部署并复跑全部离线验收，再逐类联调真实生成/提取/检查/策略角色。具体操作见 server-task-adaptation-handoff.md。本次授权到服务器联调和推理评测为止，暂不启动训练。

需要重点测量：规则识别在自然输入上的误判；JSON 与 UTF-16 定位合法率；不同任务的语义与篇幅；同名人物和章内知情；长输入分块；逐角色 Token/延迟/费用；候选采纳与记忆一致性。新产物在 TaskPanel 中以候选/报告呈现，可复制；局部改稿保留完整采纳、拒绝、部分采纳和撤销。
