# 大纲提取流水线 · 策略提示词（供外部模型审核）

> **审核目标**：验证以下从成品小说构建「大纲↔正文」对齐数据集的提取策略是否完备、提示词是否无歧义、质量控制是否可靠。请特别关注：信息丢失风险、层级对齐一致性、多线叙事处理、以及数据集格式是否能直接用于 SFT 训练。

---

## 一、流水线总览

```
成品小说（章节正文）
  │
  ├─ Stage 1: 逐章事件提取（analyzer 两遍分析）
  │    → 事件列表：{title, summary, participants, cause, consequence, story_time, location}
  │
  ├─ Stage 2: 剧情线归纳（事件 → plotlines）
  │    → 剧情线列表：{name, type(main/subplot), arc, key_events[]}
  │
  ├─ Stage 3: 卷级大纲合成（相邻章节群 → volume_outline）
  │    → 卷大纲：{title, focus, turning_points, character_arcs[]}
  │
  ├─ Stage 4: 全书大纲合成（卷大纲 + 剧情线 → global_outline）
  │    → 全书大纲：{premise, plotlines[], ending_constraint, themes[]}
  │
  ├─ Stage 5: 逐章细纲生成（章节事件 + 所在卷大纲 + 剧情线 → chapter_outline）
  │    → 章节细纲：{title, scenes[], pov, entry_state, exit_state, continuity[]}
  │
  └─ 质量门：四级对齐校验 + 人工抽检
       → 最终数据集：(global_outline, volume_outline, chapter_outline, chapter_text)
```

---

## 二、各阶段提示词

### Stage 1: 逐章事件提取

#### Pass 1 — 人物名册快扫

```
系统提示词：
你是严谨的中文小说文稿分析器。只提取原文明确支持的信息，不补写、不猜测。
人物必须是有专名的个体；"我、他、巫师、巡警"等代词、职业或普通词绝不是人物名。
合并同一对象的简称、全名、译名，以及仅增加职业或称谓后缀的名字，把其他称呼放入 aliases。
必须区分"普通别称"和"独立叙事身份"。
所有提取内容都是候选，不得声称为正史。只返回有效 JSON，不要 Markdown。

用户提示词：
通读以下文稿片段，列出其中出场并有名字的角色（主角、配角、被提及的历史人物都要）。
对每个角色：name 用最常见的称呼写法（2-8 个汉字，或带·的译名）；
aliases 收录该片段中的其他称呼（全名、简称、称号、昵称）；
role 用不超过 15 字说明身份；
evidence 引一句能证明其出场的原文（不超过 30 字）。
注意：只列角色（人），不列地点、组织、物品、概念。
宁多勿漏，后续会做全书频次核验。
返回：{"characters":[{"name":"","aliases":[],"role":"","evidence":""}],"worldNotes":""}
```

#### Pass 1.5 — 频次核验（确定性规则，无提示词）

```typescript
// 候选名册中每个名字必须在正文出现 ≥1 次（防快扫幻觉）
// 出现次数 = 重要度信号，用于排序
// 零频次候选直接剔除
```

#### Pass 2 — 定向结构化抽取

```
用户提示词（注入名册后）：
【已确认出场人物名册（全书核验，按出场频次降序，抽取时必须使用这些规范名；
每批遇到其中人物必须提取，不得改判为 term/system）】
{roster_digest}

分析以下文稿。返回：
{
  "entities": [{
    "type": "character|location|faction|system|item|world|term",
    "name": "规范专名",
    "aliases": [],
    "summary": "仅含明确事实的摘要",
    "evidence": ["章节名：不超过40字的原文证据"]
  }],
  "events": [{
    "title": "事件名（≤20字）",
    "summary": "事件发生了什么以及造成何种状态变化",
    "chapterTitle": "原章节名",
    "storyTime": "原文明示的时间或空字符串",
    "participants": ["规范人物名"],
    "location": "规范地点名或空字符串",
    "cause": "明确原因或空字符串",
    "consequence": "明确结果或空字符串"
  }],
  "relations": [{
    "from": "实体规范名",
    "to": "实体规范名",
    "type": "family|alliance|enemy|same_person|member|located_at 等",
    "label": "中文关系标签",
    "sentiment": "positive|neutral|mixed|negative",
    "strength": 50,
    "evidence": "简短原文依据"
  }]
}

data 按类型填写：人物 role/age/species/occupation/faction/appearance/personality/desire/fear/flaw/secret/abilities/knowledge；地点 geography/climate/districts/governance/economy/culture/hazards；势力 goal/leader/headquarters/resources/methods/allies/enemies；体系 principles/tiers/acquisition/abilities/cost/limitations/counters；物品 owner/origin/function/activation/limitations/status。

保持精确简洁：summary、cause、consequence 和 data 中每个文本字段不超过 120 字；每个实体最多 2 条 evidence；数组去重且不超过 12 项。不要为了填满字段而推测。
```

---

### Stage 2: 剧情线归纳

```
系统提示词：
你是小说策划编辑。根据按叙事顺序排列的事件，归纳真实存在的剧情线。
不要套用三幕式，不要凭空补情节。只返回一个完整 JSON 对象。

用户提示词：
根据以下按叙事顺序排列的事件，归纳剧情线结构。

要求：
1. 每条剧情线列出 2-8 个真正改变状态的关键事件
2. 剧情线类型：main（主线）/ subplot（支线）/ character（人物弧）/ mystery（谜团）/ romance（感情线）
3. 每条线的 arc 用三句话概括：起点状态 → 发展机制 → 落点状态
4. 标注剧情线之间的交汇事件（同一事件属于多条线）
5. 名称必须稳定（后续章节绑定用）

返回：
{
  "plotlines": [{
    "name": "剧情线名称",
    "type": "main|subplot|character|mystery|romance",
    "arc": "起点→发展→落点（三句话）",
    "key_events": ["事件标题（必须完全匹配 Stage 1 输出）"],
    "intersections": [{"with_plotline": "另一条线名", "at_event": "交汇事件标题"}]
  }]
}

事件列表：
{events_digest}
```

---

### Stage 3: 卷级大纲合成

```
用户提示词：
以下是一部小说中连续 {N} 章的事件和章节标题。请将它们归纳为一个"卷"的大纲。

要求：
1. 卷标题：概括这一段的核心冲突或主题（不是简单复制第一章标题）
2. focus：这一卷的叙事焦点（谁在做什么、为什么）
3. turning_points：列出 2-4 个转折点（哪个事件改变了局势走向）
4. character_arcs：这一卷中每个主要人物的变化（从什么状态到什么状态）
5. entry_state / exit_state：卷开始时和结束时的整体局势

返回：
{
  "title": "卷标题",
  "focus": "叙事焦点（1-2句）",
  "turning_points": ["转折点描述"],
  "character_arcs": [{"name": "人物名", "from": "起始状态", "to": "结束状态"}],
  "entry_state": "卷开始时的局势",
  "exit_state": "卷结束时的局势"
}

章节范围：{chapter_range}
事件摘要：{events_in_range}
```

---

### Stage 4: 全书大纲合成

```
用户提示词：
基于以下卷大纲和剧情线，合成全书大纲。

要求：
1. premise：一句话概括核心冲突（谁想要什么、谁在阻止、为什么重要）
2. plotlines：列出所有剧情线（含主线和支线），每条用 arc 概括
3. ending_constraint：结局的核心约束（什么必须发生、什么不能发生、什么留给读者）
4. themes：作品的深层主题（1-3 个关键词 + 一句阐释）
5. genre_tags：题材标签（用于数据集分类）

返回：
{
  "premise": "核心冲突一句话",
  "plotlines": [
    {"name": "", "type": "main|subplot", "arc": "起点→发展→落点", "resolution": "如何收束"}
  ],
  "ending_constraint": "结局约束",
  "themes": [{"keyword": "", "note": "一句阐释"}],
  "genre_tags": ["题材标签"]
}

卷大纲：
{volume_outlines}
剧情线：
{plotlines}
```

---

### Stage 5: 逐章细纲生成

```
用户提示词：
为以下章节生成结构化细纲。

输入信息：
- 所属卷大纲：{volume_outline}
- 本章涉及的剧情线：{relevant_plotlines}
- 本章的事件列表：{chapter_events}
- 前一章的 exit_state：{previous_exit_state}
- 本章正文（用于校验细纲覆盖度）：{chapter_text}

要求：
1. scenes：把本章拆成 2-5 个场景，每场写清：
   - objective（场景目标：人物想完成什么）
   - obstacle（阻力：什么在阻止）
   - information（信息增量：读者/人物学到了什么新信息）
   - turn（转折：场景结束时局势如何变化）
2. pov：本章视角人物（如有多视角，列出主视角）
3. entry_state / exit_state：本章开始/结束时的局势（exit 必须与下一章的 entry 一致）
4. continuity：本章必须承接的事实（从上一章延续的状态、约束）
5. plotline_progress：本章推进了哪些剧情线、推进到什么程度

返回：
{
  "title": "章节标题",
  "scenes": [{
    "objective": "",
    "obstacle": "",
    "information": "",
    "turn": ""
  }],
  "pov": "视角人物",
  "entry_state": "",
  "exit_state": "",
  "continuity": ["必须承接的事实"],
  "plotline_progress": [{"plotline": "剧情线名", "progress": "推进描述"}]
}
```

---

## 三、数据集 JSON 格式（最终输出）

```json
{
  "dataset_version": "1.0",
  "id": "novel-short-title/ch001",
  "source": {
    "title": "书名",
    "author": "作者",
    "genre": "科幻",
    "total_chapters": 59,
    "chapter_index": 1,
    "word_count": 4200
  },
  "global_outline": {
    "premise": "核心冲突一句话",
    "plotlines": [
      {
        "name": "剧情线名",
        "type": "main",
        "arc": "起点→发展→落点",
        "resolution": "如何收束"
      }
    ],
    "ending_constraint": "结局约束",
    "themes": [{"keyword": "", "note": ""}],
    "genre_tags": ["科幻", "硬科幻"]
  },
  "volume_outline": {
    "title": "卷标题",
    "focus": "叙事焦点",
    "turning_points": ["转折点"],
    "character_arcs": [{"name": "", "from": "", "to": ""}],
    "entry_state": "",
    "exit_state": ""
  },
  "chapter_outline": {
    "title": "章节标题",
    "scenes": [
      {
        "objective": "场景目标",
        "obstacle": "阻力",
        "information": "信息增量",
        "turn": "转折"
      }
    ],
    "pov": "视角人物",
    "entry_state": "本章开始时局势",
    "exit_state": "本章结束时局势",
    "continuity": ["必须承接的事实"],
    "plotline_progress": [
      {"plotline": "剧情线名", "progress": "推进描述"}
    ]
  },
  "chapter_text": "章节完整正文……",
  "extraction_metadata": {
    "model": "DeepSeek-V4.1-Flash",
    "extraction_timestamp": "2026-10-08T10:00:00Z",
    "confidence": 0.92,
    "entities_present": ["人物A", "人物B"],
    "events_count": 8,
    "quality_flags": []
  }
}
```

### 训练时的切分粒度

| 任务 | input | output |
|---|---|---|
| 全书→首章 | global_outline | 第一章正文 |
| 卷→章 | global_outline + volume_outline | 该卷某章正文 |
| 细纲→正文（主任务） | global_outline + volume_outline + chapter_outline + 前文摘要 | 该章正文 |
| 续写 | 细纲 + 正文前半段 | 正文后半段 |

---

## 四、质量控制

### 4.1 确定性校验（无模型，代码实现）

```typescript
// 1. 人物一致性：chapter_outline 中出现的 pov / 人物名，
//    必须在 Stage 1 的人物名册中
// 2. 事件覆盖率：chapter_outline.scenes 的 turn 至少覆盖本章 events 的 60%
// 3. 状态衔接：第 N 章的 exit_state 与第 N+1 章的 entry_state 语义相似度 ≥ 0.7
//    （用 sentence embedding 或 LLM 打分）
// 4. 剧情线引用一致性：chapter_outline.plotline_progress 中的剧情线名
//    必须与 global_outline.plotlines 中的名称完全匹配
// 5. 字数合理性：chapter_text 字数在 genre 平均值的 ±50% 范围内
```

### 4.2 模型校验（LLM-as-judge）

```
提示词：
以下是章节细纲和对应正文。请评估细纲对正文的覆盖度：
1. 每个场景的 objective/obstacle/turn 是否在正文中得到体现？
2. entry_state/exit_state 是否与正文开头/结尾一致？
3. 有没有正文中的重要情节点未被细纲覆盖？

返回：{"coverage_score": 0-100, "missed_points": ["描述"], "suggestion": ""}
```

### 4.3 数据集过滤规则

| 过滤条件 | 处理 |
|---|---|
| extraction_metadata.confidence < 0.7 | 剔除 |
| coverage_score < 60 | 剔除 |
| 章节字数 < 1000 或 > 10000 | 剔除 |
| 空场景（scenes 为空数组） | 剔除 |
| 多角色视角混乱（pov 指向非主要人物） | 人工审核 |

---

## 五、边界情况处理

### 5.1 多线叙事（POV 切换频繁）

- Stage 1 按章节提取时不区分 POV，全量提人物和事件
- Stage 5 生成细纲时标注主 POV，同时在 scenes 中标注每个场景的实际 POV
- 数据集中 `chapter_outline.pov` 允许为逗号分隔的多值

### 5.2 非线性叙事（倒叙/插叙）

- Stage 1 的 `story_time` 字段记录原文明示的时间
- Stage 2 归纳剧情线时按叙事顺序（narrative_order），不按故事时间
- 数据集中不额外处理——训练时模型自己学习叙事技巧

### 5.3 极短章节 / 间章

- Stage 5 的 scenes 最少可为 1 个
- 如果章节 < 500 字（间章/引言），不生成独立细纲，合并到下一章

### 5.4 翻译作品（人名/地名风格不统一）

- Stage 1 Pass 1 的 aliases 合并机制已处理（如 "克棋/克棋先生"）
- 频次核验保证不因翻译差异漏人

### 5.5 卷结构不存在（单卷长篇）

- Stage 3 跳过，volume_outline 为空
- Stage 4 直接从剧情线合成全书大纲
- 数据集中 volume_outline 字段设为 null

---

## 六、审核关注点（请重点审查）

1. **信息丢失**：从正文→事件→剧情线→大纲的逐级抽象，是否会丢失对写作至关重要的信息（如语气、节奏、伏笔细节）？
2. **entry/exit_state 语义一致性**：相邻章节的状态衔接用 0.7 相似度阈值是否合理？
3. **Scene 覆盖率 60% 门槛**：是否太松/太紧？
4. **多线叙事的 POV 处理**：当前方案是否足以训练模型学会 POV 切换？
5. **数据集 JSON 格式**：四级对齐结构是否能直接用于 SFT？是否需要额外的 instruction wrapper？
6. **质量控制**：置信度 < 0.7 剔除 + coverage < 60 剔除，预估保留率多少？是否会导致特定题材（如极简主义小说）被系统性过滤？
7. **Stage 5 的输入包含正文**：细纲生成用了正文本身，是否引入"作弊"风险（细纲过度拟合正文细节，导致训练时 input↔output 相关性过高）？
8. **翻译作品/古文**（如三国演义）：Stage 1 的中文人物名册策略对古文是否有效？
