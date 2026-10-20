# NovelWeaver → 训练管线优化方案

基于面试反馈的三个方向（底稿小模型训练 / 全模型 Benchmark / 大纲→正文数据集与训练），以 NovelWeaver 现有能力为基础设施的完整落地方案。

## 核心洞察：NovelWeaver 已经是这三个任务的前半段

```
面试任务                          NovelWeaver 已有对应模块
─────────────────────────────    ─────────────────────────────────────
成品正文 → 数据集（大纲提取）      importer（多格式解析→章节切分）
                                 analyzer（正文→实体/事件/剧情线）
                                 planner（大纲↔剧情线↔章节细纲 双向）
底稿小模型 + Reward Model         generation（上下文组装 + 生成）
                                 review（规则连续性检查）
                                 eval/generation-core（引用有效性/数字接地率）
全模型 Benchmark                  eval/ 整套框架（金标准/基线/回归门）
                                 关系图谱 + 审查中心（结构化评估基建）
```

**关键优势：NovelWeaver 的确定性规则引擎天然就是 Reward Model 的规则组件，不需要从零设计。**

---

## 阶段一：数据集构建（所有后续任务的地基）

### 1.1 大纲提取管线（正文 → 结构化大纲）

**现有能力直接可用：**
- `importer.ts`：EPUB/PDF/TXT → 章节切分（已验证 73 万字三体、62 万字三国）
- `analyzer.ts` 两遍分析：人物名册 + 频次核验 → 定向抽取（已在首无上验证）
- `planner.ts`：大纲 → 剧情线/分卷/逐章细纲（反向：事件 → 大纲归纳已有）

**需要新增：`eval/build-dataset.ts`（大纲提取器）**

```
输入：成品小说（章节正文）
  ↓
Step 1: analyzer 提取事件序列（title, summary, participants, cause, consequence）
  ↓
Step 2: planner 反向归纳：事件 → 剧情线 → 卷结构 → 全书大纲
  ↓
Step 3: 逐章生成"章节级大纲"（用 analyzer 的 chapterTitle 对齐）
  ↓
输出：(全书大纲, 卷大纲, 章节细纲, 章节正文) 四级对齐数据
```

### 1.2 数据集 JSON 格式设计

```json
{
  "id": "san-ti-ch001",
  "source": "三体",
  "author": "刘慈欣",
  "global_outline": {
    "premise": "文化大革命期间的天体物理学家叶文洁向宇宙发出信号...",
    "plotlines": [
      {"name": "叶文洁与红岸基地", "type": "main", "arc": "…"},
      {"name": "汪淼调查与三体游戏", "type": "main", "arc": "…"}
    ],
    "ending_constraint": "人类文明进入危机纪元"
  },
  "volume_outline": {"title": "第一部", "focus": "…"},
  "chapter_outline": {
    "title": "疯狂年代",
    "scenes": [
      {"objective": "…", "obstacle": "…", "turn": "…"}
    ],
    "pov": "叶文洁",
    "entry_state": "…", "exit_state": "…"
  },
  "chapter_text": "疯狂年代的正文……",
  "metadata": {
    "word_count": 4200,
    "genre": "科幻",
    "extraction_model": "DeepSeek-V4.1-Flash",
    "extraction_confidence": 0.92,
    "entities_present": ["叶文洁", "叶哲泰", "绍琳"]
  }
}
```

**设计要点：**
- **四级对齐**：全书大纲→卷→章节细纲→正文，训练时可以按粒度切分（全书→章 / 卷→章 / 细纲→正文）
- **entry/exit state**：教模型学会"承接上文"而不是从零开始——这是长篇小说生成的核心难点
- **extraction_confidence**：低置信度样本可过滤，提高数据质量
- **entities_present**：后续可用来验证生成结果是否覆盖了大纲要求的人物

### 1.3 语料现状与扩充

| 语料 | 字数 | 用途 |
|---|---|---|
| 三体 | 73 万 | 科幻长篇，多线叙事 |
| 三国演义 | 62 万 | 历史，群像，古文风格 |
| 霍比特人 | 19 万 | 奇幻，单一主线 |
| 首无 | 23 万 | 推理，伏笔密布 |
| 故去的呢喃 | 2 万 | 原创试读，版权干净 |
| 雾港纪事 | <1 万 | 演示种子 |

**扩充建议**：加 20-50 部公版/授权作品（豆瓣阅读开放作品、古登堡公版），覆盖言情/悬疑/都市/玄幻。总量目标 500 万-1000 万字对齐数据。

### 1.4 大纲提取本身的训练（面试提到的"语义分割与提取"）

```
Phase 1（现在就能做）: 用大模型 prompt 做零样本提取 → NovelWeaver analyzer
Phase 2: 积累 10k+ 高质量对齐数据 → 蒸馏到小模型（Qwen 2.5-7B LoRA）
Phase 3: 小模型提取 + 大模型校验 → 半自动流水线
```

NovelWeaver 的 `extraction-hobbit.json`（29 条 ground truth，GT 召回 100%）就是提取质量评估的模板。

---

## 阶段二：底稿小模型训练 + Reward Model

### 2.1 基座选择

| 方案 | 模型 | 理由 |
|---|---|---|
| 推荐 | Qwen 2.5-7B-Instruct | 中文最强开源、LoRA 生态成熟、Seed 团队可能熟悉 Qwen 系 |
| 备选 | Qwen 2.5-3B | 资源受限时的轻量方案 |
| 实验 | Qwen 2.5-14B | 验证规模收益 |

### 2.2 SFT（监督微调）

```
训练样本格式:
  input:  全书大纲 + 卷大纲 + 本章细纲 + 前文摘要 + entry_state
  output: 章节正文

来自阶段一的四级对齐数据集，按 chapter 粒度切分。
```

**NovelWeaver 的 `assembleContext` 就是 input 侧的完美模板**——它已经解决了"模型该看什么"的问题（人物状态卡、剧情线、原文证据、token 预算），把它的输出格式直接作为 SFT 的 input format。

### 2.3 Reward Model 设计（面试重点）

**分层 Reward 架构：**

```
Layer 1: 规则 Reward（可验证，NovelWeaver 直接复用）
  ├── 引用有效率：生成中 [Rn] 是否指向真实证据（generation-core.ts）
  ├── 数字接地率：数字是否在上下文中（排除序号）
  ├── 人物一致性：出场人物是否在大纲/上下文中
  ├── 视角一致性：是否保持指定 POV
  └── 连续性规则：review.ts 的 precheckChapter（缺视角/缺时间/伏笔未回收）

Layer 2: 模型 Reward（需训练）
  ├── 文笔质量：LLM-as-judge 打分（流畅性/意象/节奏）
  ├── 剧情推进：是否完成了细纲要求的场景
  └── 人物弧光：行为是否符合角色设定

Layer 3: 对比 Reward（DPO/RLHF 用）
  └── 同一细纲 → 多个生成 → 人工偏好排序 → 偏好对
```

**具体实现路径：**

```
Step 1: 用 NovelWeaver 的规则引擎做确定性 Reward
        → 零成本、无偏差、可复现
Step 2: 用大模型（GPT-4/Claude/Seed）做 LLM-as-judge
        → 构建文笔质量标注
Step 3: 人工标注 500-1000 对偏好
        → 训练 Reward Model（用 Qwen 2.5-7B 做 backbone）
Step 4: DPO（比 RLHF 简单且稳定）
        → 用 Reward Model 对 SFT 模型输出的偏好对做优化
```

### 2.4 NovelWeaver 在训练中的角色

```
训练前：数据集构建 + 质量过滤（extraction_confidence, 规则审查）
训练中：assembleContext 作为 input 侧标准化模板
训练后：eval/generation-core 作为自动评估（引用有效率/接地率/完整度）
        review.ts 规则引擎作为线上推理的实时检查
```

---

## 阶段三：全模型 Benchmark

### 3.1 Benchmark 设计（面试任务 2）

**名称建议：NovelBench**

**评估维度（对标现有 eval 体系扩展）：**

| 维度 | 评估方式 | NovelWeaver 模块 |
|---|---|---|
| 大纲忠实度 | 生成是否覆盖细纲全部场景 | planner 的 scene 列表 |
| 人物一致性 | 出场人物/行为是否与设定卡一致 | 实体约束字段 |
| 连续性 | 时间线/知识边界/伏笔 | review.ts 规则 |
| 接地性 | 引用有效/数字接地 | generation-core.ts |
| 文笔质量 | LLM-as-judge + 人工抽检 | — |
| 剧情推进 | 是否完成 scene 的 objective/turn | 细纲结构化字段 |

### 3.2 Benchmark 数据集

```
来源：阶段一的四级对齐数据集
采样策略：
  - 按题材分层（科幻/历史/奇幻/推理/言情）
  - 按章节位置分层（开篇/中段/高潮/结尾）
  - 每个模型跑 50-100 章，覆盖 5-10 部作品
```

### 3.3 评分流程

```typescript
// eval/run-benchmark.ts（扩展现有 run-generation-eval.ts）
interface BenchmarkResult {
  model: string                    // DeepSeek / Seed / GPT / Claude / Qwen...
  scores: {
    outlineFidelity: number        // 场景覆盖率
    characterConsistency: number   // 人物行为一致性
    continuity: number             // 时间线/知识边界
    groundedness: number           // 引用有效+数字接地
    prose: number                  // LLM-as-judge
    plotAdvancement: number        // 剧情推进
  }
  aggregate: number                // 加权总分
}
```

### 3.4 Seed 模型接入

NovelWeaver 已支持任意 OpenAI 兼容 API——Seed 模型只需在设置页填 Base URL / 模型名 / Key。Benchmark 脚本通过 `/api/model` 动态切换模型，对同一批大纲逐模型生成并评分。

### 3.5 公平性保障

- 同一上下文快照（assembleContext 输出固定）
- 同一 temperature（0.75）和 max_tokens
- 每个任务跑 3 次取均值（降低采样波动）
- 规则维度全自动评分（无人工偏差）
- LLM-as-judge 用固定的 judge 模型 + few-shot 示例

---

## 实施时间线

```
第 1-2 周（立即启动）
  ├── [ ] eval/build-dataset.ts：大纲提取流水线（用现有 analyzer + planner）
  ├── [ ] 数据集 JSON schema 定稿 + 三体/三国/首无/霍比特人 4 部全量提取
  └── [ ] NovelBench v0：6 维度评分脚本（扩展现有 generation-core）

第 3-4 周
  ├── [ ] 语料扩充到 20+ 部 / 500 万字
  ├── [ ] SFT 数据准备：四级对齐 → instruction format
  ├── [ ] Qwen 2.5-7B LoRA SFT v0（在 4 部书上验证）
  └── [ ] Benchmark 跑通：DeepSeek vs GPT vs Claude vs Qwen vs Seed

第 5-8 周
  ├── [ ] Reward Model v0：规则层 + LLM-as-judge 层
  ├── [ ] DPO：500 对偏好标注 + 偏好优化
  ├── [ ] 小模型 vs 大模型 Benchmark 对比（核心演示）
  └── [ ] 大纲提取蒸馏：小模型替代 prompt 提取

第 9-12 周
  ├── [ ] 端到端 demo：大纲 → 小模型生成底稿 → 规则审查 → 导出
  ├── [ ] NovelBench 正式发布（GitHub + 技术报告）
  └── [ ] 面试演示：全流程 + Benchmark 排行榜
```

---

## 面试叙事框架

**"我从工程出发，反推出训练需求"**

1. **展示产品**：NovelWeaver 已经是一个能跑的长篇小说创作工作台——不是 toy project
2. **展示评估体系**：四条评测线（检索/提取/审查/生成）+ 金标准 + 回归门——这就是 Benchmark 的基础
3. **展示数据管线**：importer → analyzer → planner 双向转换——这就是数据集构建
4. **展示 Rule Reward**：引用有效性/数字接地/连续性检查——这就是 Reward Model 的规则层
5. **提出训练方案**：基于以上基建，SFT + DPO 是自然延伸，不是从零开始
6. **Benchmark 排行榜**：Seed vs 全部主流模型——直接回应字节的测试需求

**关键话术**："我不是从模型出发找应用场景，而是从作者的真实痛点出发建了产品基建，训练是基建成熟后的下一步——数据集、评估、Reward 信号都已经在产品里验证过了。"
