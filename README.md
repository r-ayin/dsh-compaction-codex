# dsh-compaction-codex

Codex 式换窗压缩引擎——彻底替换官方 dsh-compaction-basic 的「LLM 摘要式压缩」。

## 机制

- 继承官方 `BasicCompactionEngine`，只覆写官方承诺的唯一子类钩子 `summarize()`；
- 摘要改为**纯确定性指针模板（零 LLM 调用）**：归档声明 + 恢复通道指引（history_search / history_read / notes read）+ 最近 model 检查点笔记全文（读 `~/.dsh/context-budget/notes/<sid>.jsonl`，只读）+ 被归档区首尾消息截断锚点；
- SummaryResult 走官方契约的模板分支（无 `llmStreamCall` 字段，官方注释点名 "template, remote, or other summarizer"），转录中 `compaction/summary` 事件显示 `provider: template, model: codex-rollover`；
- shadow 事务、replay 定价、工具配对平衡、并发锁、阈值自动触发（0.8×窗口，router-standard 为 0.55）、context-overflow 恢复、/compact（compactNow）全部原样继承。

## 装配

- 源码：`~/.dsh/plugins-src/dsh-compaction-codex/`（本目录），构建：`bash scripts/build.sh`（链接 dsh-install 类型依赖 + tsc 编译 src → lib）；
- profile 链：`~/.dsh/profiles/web/node_modules/dsh-compaction-codex` 软链 + `package.json` link 依赖（防 pnpm install 剪掉）；
- 预设：6 个用户预设（code / code-guarded / code-lean / dshagent / designharness / router-standard）compaction 组中 `compaction-basic` 条目已替换为 `compaction-codex`（2026-09-29，各文件留有 `.bak-20260929` 备份）；
- 生效范围：仅新会话（预设热扫描；运行中会话保持旧代装配）。

## 约束与边缘

- 官方 `summarizeCompaction` 要求摘要帧 token 数 < 被 shadow 内容 token 数；本模板上限约 5K 字符（约 1.5K tokens），对数千 tokens 以上的压缩区安全；极小压缩区会按官方逻辑抛错并留在日志（不会静默）；
- notes 文件缺失/损坏时自动降级（省略检查点段），不阻塞压缩事务；
- 回滚：预设 yml 中把 name 改回 `@deepseek-ai/dsh-compaction-basic`（或恢复 .bak）即回官方 LLM 摘要，热生效（新会话）。

## 决策记录

- 2026-09-29 用户拍板：方案 A（子类替换）+ 纯 Codex 式（永不 LLM 摘要，无混合开关）；
- 否决方案 B（从零实现抽象 CompactionEngine：需重写 shadow 持久化/锁/配对平衡，收益零风险高）与方案 C（拆压缩组：长会话必撞上下文硬上限）。
