import { z } from 'zod'
import { structuredCompletion } from './ai.ts'
import { parseModelJson } from './analyzer.ts'

const eventSchema = z.object({
  title: z.string().min(1), summary: z.string().default(''), phase: z.string().default(''),
  participants: z.array(z.string()).default([]), location: z.string().default(''),
  cause: z.string().default(''), consequence: z.string().default(''),
})

const plotlineSchema = z.object({
  plotlines: z.array(z.object({
    name: z.string().min(1),
    type: z.enum(['main', 'subplot', 'character', 'mystery', 'romance', 'framework']).default('subplot'),
    summary: z.string().default(''),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    events: z.array(eventSchema).default([]),
  })).max(12).default([]),
})

const sceneSchema = z.object({
  title: z.string().default(''), objective: z.string().default(''), obstacle: z.string().default(''),
  information: z.string().default(''), turn: z.string().default(''),
})

const volumeSchema = z.object({
  volumes: z.array(z.object({
    title: z.string().min(1), summary: z.string().default(''),
    chapters: z.array(z.object({
      title: z.string().min(1), summary: z.string().default(''), pov: z.string().default(''),
      targetWords: z.number().int().min(500).max(20000).default(3000),
      purpose: z.string().default(''), entryState: z.string().default(''),
      scenes: z.array(sceneSchema).min(1).max(10), exitState: z.string().default(''),
      continuity: z.array(z.string()).default([]), plotlineNames: z.array(z.string()).default([]),
    })).min(1).max(40),
  })).min(1).max(12),
})

export const outlineDecompositionSchema = plotlineSchema.and(volumeSchema)
export type OutlineDecomposition = z.infer<typeof outlineDecompositionSchema>

const system = `你是小说策划编辑。根据已经确认的全书大纲进行结构拆分，不改写核心故事，不擅自把候选假设当正史。
可以处理单核、群像、单元剧、主线转移、多中心拼图和探索式故事，不得强制使用三幕式。
结构要求：必须拆出**恰好一条 main 主线**（全书核心冲突/追问的推进轴，贯穿首尾），
外加**至少两条支线**（人物弧 / 谜团 / 感情线 / 势力线等）；主线与支线要有明确的交汇点
（某章同时推进两条线），支线在主线关键时刻收束或反哺主线。群像或主线转移故事的"主线"
可以是反复出现的问题或场域，但必须存在且唯一。
只返回一个完整 JSON 对象，不要 Markdown、解释或思考过程。`

async function parseStructured<T>(schema: z.ZodType<T>, prompt: string) {
  const raw = await structuredCompletion(system, prompt)
  return schema.parse(parseModelJson(raw))
}

export async function decomposeOutline(input: { projectName: string; premise: string; outline: string }) {
  const shared = `项目：${input.projectName}\n项目梗概：${input.premise}\n\n【当前采用的大纲】\n${input.outline}`
  const plotPrompt = `${shared}\n\n拆分剧情线结构：1 条 type="main" 的主线（全书核心冲突，8 个左右关键事件，覆盖开端-升级-高潮-收束）+ 至少 2 条支线（人物弧/谜团/感情线/势力线，各 2-6 个事件）。在主线 summary 末尾注明"交汇点：与〈支线名〉在〈事件/阶段〉交汇"；支线 summary 注明它如何反哺或对照主线。每条线的事件必须真正改变状态。名称必须稳定，供章节绑定。返回：\n{"plotlines":[{"name":"名称","type":"main|subplot|character|mystery|romance|framework","summary":"起点、发展机制和落点","color":"#13766f","events":[{"title":"事件","summary":"状态变化","phase":"所属卷或阶段","participants":[],"location":"","cause":"","consequence":""}]}]}`
  const chapterPrompt = `${shared}\n\n把大纲拆成可直接进入写作台的分卷与章节细纲。规模应服从原大纲；信息不足时优先生成较少但完整的章节，不要用空洞占位凑数量。每章必须有明确进入状态、场景推进和退出状态；群像或主线转移故事允许 POV 为空或变化。
剧情线编织要求：每章的 plotlineNames 必须至少绑定一条线；全书约每 3-4 章安排一章同时推进主线+支线（交汇章），高潮章必须同时收束主线与至少一条支线。返回：\n{"volumes":[{"title":"卷名","summary":"本卷驱动力和卷末变化","chapters":[{"title":"章名","summary":"本章信息增量与状态变化","pov":"视角或空字符串","targetWords":3000,"purpose":"本章叙事职责","entryState":"开场时人物/局势状态","scenes":[{"title":"场景名","objective":"场景目标","obstacle":"阻力","information":"新增信息","turn":"转折"}],"exitState":"结尾后的新状态","continuity":["必须承接或不得违背的事实"],"plotlineNames":["完全匹配的剧情线名称"]}]}]}`
  const [plot, chapters] = await Promise.all([
    parseStructured(plotlineSchema, plotPrompt),
    parseStructured(volumeSchema, chapterPrompt),
  ])
  return { ...plot, ...chapters }
}

export function chapterOutlineMarkdown(chapter: OutlineDecomposition['volumes'][number]['chapters'][number]) {
  const scenes = chapter.scenes.map((scene, index) => `### 场景 ${index + 1}：${scene.title || '未命名场景'}\n\n- **目标**：${scene.objective}\n- **阻力**：${scene.obstacle}\n- **信息增量**：${scene.information}\n- **转折**：${scene.turn}`).join('\n\n')
  const continuity = chapter.continuity.length ? chapter.continuity.map((item) => `- ${item}`).join('\n') : '- 暂无额外约束'
  return `## 章节职责\n\n${chapter.purpose}\n\n## 进入状态\n\n${chapter.entryState}\n\n## 场景序列\n\n${scenes}\n\n## 退出状态\n\n${chapter.exitState}\n\n## 连续性约束\n\n${continuity}\n\n## 关联剧情线\n\n${chapter.plotlineNames.join('、') || '暂未绑定'}`
}
