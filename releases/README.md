# releases/

部署快照归档目录（gitignore，不入库）。

## NovelWeaver-deploy-20260921.tar.gz

2026-09-21 的全量部署快照（源码 + 数据目录）。

**关于 `src/pages/StoryGraph.tsx`**：该快照包含此文件，但当前仓库已无此页面——其功能
（关系图与事件可视化）已被「剧情板」（PlotBoard：事件时间轴 / 剧情线泳道 / 事件看板 +
`@xyflow/react` 关系图）覆盖。经确认正式放弃回迁，此压缩包即为其最终归档；如需查阅，
解包 `tar -xzf NovelWeaver-deploy-20260921.tar.gz` 后位于
`NovelWeaver/世界观创作用agent/src/pages/StoryGraph.tsx`。
