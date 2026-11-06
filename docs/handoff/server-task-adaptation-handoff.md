# NovelWeaver 服务器任务适配联调说明

接续分支 `codex/novelweaver-task-adaptation-local`。本轮只部署、接入真实模型和做推理评测；不执行 SFT、RL、反向传播或任何参数更新。GPU 训练和模型与 Harness 的联合训练等待用户另行指令。

## 部署并验收

已有服务器仓库时先检查工作区与数据，使用独立 worktree 或新检出保留已有 datasets。下面命令适用于一个新的独立目录，使用 Node 22.x、pnpm 10.15.1：

```bash
git clone --branch codex/novelweaver-task-adaptation-local https://github.com/exuusiai/NovelWeaver.git NovelWeaver-task-adaptation
cd NovelWeaver-task-adaptation
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
NOVELWEAVER_DATA_DIR=:memory: NOVELWEAVER_OFFLINE=1 AI_API_KEY= pnpm eval
pnpm eval:harness
pnpm eval:tasks
pnpm build
cp .env.server.example .env
pnpm start
```

已有 .env 时保留其内容，按差异补充配置。默认绑定 127.0.0.1，使用现有 SSH 转发查看。读取 local-task-adaptation.md、task-profiles.json、task-schemas.json 和 acceptance 报告，核对 HEAD、工具、路由与 profile 版本。

## 联调顺序

1. **先固定路由。** 用公开或原创开发例逐类检查任务计划，覆盖长篇局部修改、短输入长产物和长输入短分析。记录误路由与作者修改；此轮不训练路由器。
2. **接真实生成与检查。** 默认网关配置来自 AI_BASE_URL/AI_MODEL/AI_API_KEY；关闭 NOVELWEAVER_OFFLINE。改稿适配器另启用 HARNESS_MODEL_ENABLED。角色分离时向 createRegistry 注入对应 adapters，HTTP 使用同一执行器。
3. **逐类小批量测量。** 规划、独立创作、续写、审查、提取、问答各做合法率、语义与成本检查。模型原始输出不得绕过 Schema；缺证据或缺检查返回 pending。
4. **接真实改稿策略。** 保留 taskSpec、profile 和不可变目标；策略直接输出 patches，按反馈选择补查、重改或 finish。先用推理测试验证成功与失败，不运行 trainer。
5. **检查产品闭环。** 检查版本冲突、部分采纳、撤销、来源失效、正文/记忆一致性。新产物是候选，正史与正文写入仍由作者控制。
6. **输出联调报告。** 按任务报告路由、工具轨迹、目标修复、事实保持、角色知识、作者偏好与资源；代码固定后才运行独立留出集。

教师 API 使用用户明确配置的金额和 Token 上限；上限未知或为零时保持离线/本地推理，先完成其他工作。配置与凭证放在 Git 之外，日志脱敏。单张 4090D 只安排一个 GPU 推理作业，不同时驻留多套大模型。

## 接口示例

```text
GET  /api/tasks/profiles
GET  /api/tasks/capabilities
POST /api/tasks/resolve
POST /api/tasks/runs
GET  /api/tasks/runs/:id
GET  /api/tasks/runs/:id/observe
POST /api/tasks/runs/:id/step
POST /api/tasks/runs/:id/snapshots
GET  /api/tasks/runs/:id/export
```

预览和运行使用相同请求。以章内续写为例：

```json
{
  "projectId": "实际项目ID",
  "chapterId": "实际章节ID",
  "operation": "continue",
  "goal": "承接前文写下一场景，保持人物知情边界",
  "storyScale": "long",
  "targetLength": { "value": 2500, "unit": "characters" },
  "holderId": "实际视角人物ID",
  "storyTick": 10
}
```

管理态 reset/restore/evaluate 不在模型工具集中。JSONL 桥接默认只做离线环境协议；真实训练适配要在用户后续授权后接入独立评分器、模型采样和 trainer。

## 本轮完成标准

服务器通过离线回归；七类任务的真实模型联调都有原始产物与明确状态；策略调用和候选修改可追踪；费用与失败分开记录。提交联调修复与报告，给出实际分支、SHA 和下一步建议。效果未达标时保留失败案例，不以 fixture 通过率代替真实质量。
