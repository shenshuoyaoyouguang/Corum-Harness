# 上游文档索引（存档）

> 2026-10-06 从 `AGENTS.md` 移出——它占原文件 75%（190/258 行），但其中**每一个路径在本仓都不存在**
> （`.gitignore` 的 `docs/` 规则把该目录整个排除，只显式放行 `fork-delta.md` 与 `assets/`）。
> 每个 session 都注入的长索引只花上下文、不产出，故降为按需查阅：仅在需要回溯上游某份规则 /
> 交接时读本文件。
>
> **要原文请向上游开发检出索取；不要按下列路径在本仓找文件。**

- **`corum-dev-conventions` 技能** — 本文件与 `docs/dev-conventions.md` 的**可执行投影**
  （红线 / 改动工作流 / 已付学费的坑 / 证据标准 / 协作纪律），源码在本仓
  `skills/corum-dev-conventions/SKILL.md`，装进 corum 技能库并绑定给「Corum 开发」。
  改规范时**先改 docs，再同步这份技能**（docs 是规则的唯一家）。
- `docs/dev-conventions.md` — **the single home for rules** (must/never, decision
  trees, code do/don't, evidence index; §4a = subagent dual-instance discipline,
  §8 = event bus, §9 = mounting, §10 = agent/LLM mechanism, §11 = documentation
  discipline, §12 = team scheduler log, §13 = UI interaction red lines).
- `docs/VERSIONING.md` — **版本号规则与发布台账**（2026-10-03 定）：应用版本与 dsh
  基座版本**分两条线**（界面只显示应用版本，基座版本只进「复制诊断信息」）；取值一律从
  安装产物读、不许手填；**每次发版在台账追一行**（应用版 ↔ 基座版映射的唯一事实源）。
- `docs/LESSONS.md` — **the single home for experience**: phenomenon → root cause
  → practice, with source anchors (build/bundling, cordis, cross-bundle state,
  UI/CSS, sessions, subagents/orchestration, event bus, models, debugging
  recipes, collaboration). Rules do **not** go here; they graduate into
  `dev-conventions.md`.
- `docs/HANDOFF-2026-09-25-model-ask-key-and-memory-mechanism.md` — **最新交接**
  （2026-09-22/25 场：① **J+K 决策面板卡死真因修复**；② 记忆机制方案定稿；③ 台账大清账；
  已推送 `origin/main`）。
  **§2 = 本场最值钱的部分**：同一缺陷**两次归因都错**（旧交接判「等待链过长」；用户测试
  后判「可能已消失」——实测完整复现）→ 真因是**面板缺 React `key` ⇒ 组件实例被复用**
  （上一轮的 `applying=true` 被带进新面板，故与重跑长度无关，**K 不需要做**）。
  **定位靠对照实验而非推理**：手动调一次 `answer()` 面板立刻消失 ⇒ 同时排除结算链与
  摘除管线两条假设。**§3 = 记忆机制**（入口 `docs/PLAN-memory-mechanism-design.md`，
  只定方案未实施）；**§6 = 本场核实的技术事实**（RPC 调用形态已变、verify 实例沙箱限制、
  **fork-drift 有 24 项既存失败与本事无关**）。
  **下个 session 从这里开始。**
- `docs/HANDOFF-2026-09-21-memory-settings-and-starfield.md` — 上一份交接
  （2026-09-21 记忆场：设置中心三页 + WebGL 球壳星云 + 列表视图；测试 64 → 137）。
  **§2 = 用户四次修正的轨迹**（我三次方向性判断错：「未实现」误判为「该删除」/
  信息架构层级猜错 / 「三维·粒子」的几何与渲染选型没先确认 —— CSS 3D 层板 →
  平面环星空 → 球壳星云，走了两段弯路）；**§3 = 六个实测缺陷**（三个连环「全黑」
  同症状不同根因：实例化属性越界 / `premultipliedAlpha` 合成异常 / 世界半径量级算错
  —— GL 状态全绿且拾取命中 557 次却整片黑，**唯一可信判据是「同一帧内 readPixels」**）；
  **§6 = 两条验证环境假象**（窗口未聚焦 ⇒ `document.hidden` ⇒ 「两帧像素一致」假绿；
  合成 pointer 事件缺 `pointermove` ⇒ 点击测不出）+ **断言不带 `expect` 等于没断言**；
  **§7 = 下个 session 起点**（最关键缺口 = 记忆来源尚未接入，`compile.ts:425` 的
  `TODO(memory)`；那也是「注入策略」整组标未上线的唯一原因）。
  功能事实源是同名的 `docs/PLAN-memory-settings-product-design.md`（六轮演进 + 缺陷清单）。
- `docs/audit/NEXT-PHASE-DEFERRED.md` — deferred/closed architecture items
  (sidebarMode service done, slot-registry service done). Note
  `docs/audit/ARCHITECTURE-REMEDIATION-TODO.md` §C1 was corrected in place
  (2026-09), but its **§C3a still carries an uncorrected superseded
  "precondition not met" conclusion** — `NEXT-PHASE-DEFERRED.md` wins.
  (Tracked: ledger `docs.audit.c3a-contradiction`.)
- `docs/HANDOFF-2026-09-29-official-0.1.5-upgrade.md` — **最新交接**
  （2026-09-29 官方基座升级场：**0.1.3-alpha.1 → 0.1.5-rc.3 全量升级已完成** ✓
  三项守卫全绿：全仓 `--force` typecheck **0 错** / 测试 **1932 通过 0 失败** / fork-drift **通过** ✓。
  **§2 = 三条必读方法论**：① `tsc -b` 是增量编译会藏住破坏点（**必须 `--force`** ✗ 否则 31 处报错看不见）；
  ② 官方 npm 包有**系统性打包缺陷**（运行时依赖被放进 `devDependencies` ✓ 本场遇 2 处 ✓
  **判定必须直接验证能否解析** ✗ 别信扫描脚本 ✓）；③ **实机验证不可替代**（本场抓出 2 个编译期发现不了的真 bug：
  侧栏插件 `require("anser") missed the module table` + 历史会话 `lacks "senderSessionId"` ✓）。
  **§3 = 交付**（基座切换 137 条 override ✓ / `corum-subagent` **1929→697** 贴官方四文件结构
  且三块旗舰增量保留 ✓ / 一个真 bug 修复：`childPersonaOf` 兜底与 deny 不一致 ✓ / UI fork 4 包适配 ✓）。
  **§4 = 未完成与注意**（一处可见性变化**已裁决收口** ✓ / 14 个无法迁移的 v2 会话**已按裁决清除并备份**在
  `~/.corum/sessions-removed-20260929/` ✓ / `standardRows` 对账**已完成无需改动** ✓ / `pwsh-persistent` 记账未动 ✓）。
  **§5 = 我本场犯的 5 个错**（增量编译被骗 / 夹具改错两次 / 扫描脚本误报两次 / 措辞夸大 / 造场景未验证生效就先解释 ✓）。
  逐步实录在 `docs/UPGRADE-0.1.5-rc3.md`（**35 个步骤**）。**下个 session 从这里开始。**）
- **`corum-official-upgrade` 技能** — 官方基座升级的可执行投影（源：`skills/corum-official-upgrade/SKILL.md`）：
  目标版本**整套装齐**的判据（0.1.7-rc.2 实测缺 5 个包 ⇒ 不可用；0.1.5 系列 189/189 ✓）、
  逐包循环（包声明 + 根 override **必须同时改**）、fork 合并手法（官方为底 + 贴回 corum 增量）、
  fork 顶替名的 override 分档规则、命令级/环境级陷阱（`--filter` 裁剪、macOS 无 `timeout`、
  **本机 `diff` 是 HarmonyOS SDK 的会静默漏报**、`DSH_BASELINE_TAG`）。
  本次升级的逐步实录在 `docs/UPGRADE-0.1.5-rc3.md`。
- `docs/fork-delta.md` — diff ledger of the fork packages (now 13, incl. the
  sandbox fork) + official-upgrade runbook (required reading before touching
  fork packages).
- `docs/HANDOFF-2026-09-10-orchestration-unification.md` — 编排统一化交接（官方四模式 +
  指挥模式 + orchestrate 双模式 + 隔离下沉 provider 层 + 提示词英文 + 非 git 降级核查）。
- `docs/PENDING-conductor-readonly-bash-and-progressive-research.md` — **指挥模式待办登记册
  （开工前必读）**（2026-09-20 起）。**本文件是「指挥模式相关待办」的单一事实源**，起因是用户指出
  「我在上一轮的报告中看到你**已经忘了**要优化指挥者的系统提示词了」——核实属实：我把指挥者提示词的
  三条评估结论只在对话里说了、没落盘，上下文压缩后彻底丢失。**纪律：凡在对话里说过「要做/该修」的事，
  必须落进这里**，否则视为没说过。
  当前登记表（**截至 2026-09-25**：A 只读 bash ✅ / B 渐进式调研 ✅（**L 实测未生效，待测试**）/
  C 集成者报告 ✅ / D1-D2 机制段能力感知 ✅ / **D3 指挥者可操作 MCP ✅ 已拍板关闭** /
  E AGENTS.md 瘦身 🔴 **改挂「项目文档治理场」** / E′ fork 注入分档 ❌ 已放弃 /
  F worker 风格 ✅ / **G master-key 🔴 待评估正式打包版** /
  **J+K 决定面板卡死 ✅ 已修复（真因=缺 React key，K 不需要做）**）。
- `docs/PLAN-2026-09-21-agent-service-architecture.md` — **上一场（2026-09-21 架构拆分场）
  的方案与进度记账**（已收口；见下方「最新交接」为当前入口）。方案 + 执行进度 + 未完成项记账。
  本轮：用户先审方案、拍板四条（Q1 先建安全网 / Q2 `createAgentForTask` 不动 /
  **Q3 只到文件层面、不插件化** / Q4 D3+G 不混入），然后 P0→P3 执行。
  **交付**：`tests/harness.ts`（造服务的唯一入口，状态搬家时 fail-loud 而不是静默失真）+
  37 条特征化测试 + `tests/fold-equivalence.spec.ts`（拿历史版本原文跑等价判据）+
  `scripts/verify-refactor-guard.sh`（25 项：RPC 面冻结 / 已知地雷 / 状态表直访预算只许降 /
  不得反向依赖）。抽出 `subagent-progress` / `change-summary` / `agent-registry` / `task-lane`
  四个模块；`agent-service.ts` 2877 → **2521** 行；测试 278 → **330**；**14 张可变表现在
  每一张都有唯一所有者，服务里直访次数全部为 0**。
  **三条本场学费**：① 测试台按状态表名字硬编码 ⇒ 搬家即静默失真（已收成契约点）；
  ②「未知」是三态不是两态（harness 把 `ctx.get` 与属性合并 ⇒ 断言测错分支）；
  ③ 判据会随代码布局失效，但**红≠该降标准**（两处文本守卫各变红一次，修法一律是扩大
  取样面/按文件逐处断言，没有降阈值）。
  **未完成**：`createAgentForTask`（Q2 裁定不动）、`conductor` 注册点仍 5 处（收敛需重排它）。
- `docs/HANDOFF-2026-09-20-conductor-permission-and-refactor.md` — 指挥模式权限护栏 + 架构拆分场
  （**已被下方「最新交接」超越；其 §3 架构拆分也已在 PLAN-2026-09-21 执行完毕**。
  留档价值：**§1 一个实测坐实的安全漏洞已修复**（用户口径见下），**§6 三条最贵认知**仍适用。
  2026-09-20 日场。**§1 = 一个实测坐实的安全漏洞已修复**：指挥模式「只读」原先用「钉会话沙箱」
  实现，而沙箱是 **last-write-wins 状态** ⇒ 用户切「完全权限」5 秒内即覆盖（实测会话
  `corum-task-e72b1a8f`；全会话普查 read-only 存活 **0** 次）。根因是 `agent-service.ts` 里
  「权限档位」与「指挥模式」两个方法**各自写同一份沙箱、互不知情**。修法 = 把约束改到
  **正交且不可覆盖**的轴（agent-scoped `tools.guard`）⇒ 主 Agent 与 research 恒只读、
  worker 仍拿到用户档位。附 **70 条回归网**（9 组合全覆盖）。
  **§3 = 🚧 正在进行的架构拆分（4/8 簇已抽，`agent-service.ts` 3209→2877）** —— 用户最终目标
  「将架构调整到合理为止」；剩 `agent-lifecycle` / `child-progress` / `change-summary` 三簇
  （深耦合类内状态，需单独一轮）。
  **§6 = 三条最贵认知**：「状态」与「策略」必须分开（补 if 无用，收成单一写入者才行）；
  机械重构**不能以「编译过+测试绿」收口**（实测 `return undefined` 被删后两者都发现不了，
  只有 `git diff` 对照 HEAD 能拦下）；凡说过「要做/该修」的事**必须落进登记册**。）
- `docs/HANDOFF-2026-09-19-model-ask-panel-and-restart-gate.md` — 上一份交接
  （2026-09-19 夜场，用户换会话执行重启。**§1 = 重启前必须先重打包**：主实例跑的是打包态
  （`run/pack-9222.pid`），打包快照 13:41:37，而本场改动 21:31~22:02 ⇒ **直接重启看不到任何效果**
  （新插件 `@corum/corum-ui-model-ask` 根本不在闭包里、打包 patch 也没有它的注册行）；
  §2 = 本场 9 个提交（方案C 决定面板新插件 + 四个真 bug + 视觉 1:1 + 三类交互缺陷）；
  §3 = 环境状态与复位判据（preset 已全部复位、无残留）；§5 = **未验证项如实标注**（主实例从未验过、
  `npm run pack` 未实际跑过）+ 重启后 8 条验收清单。
  **本场最贵的一课**：报障「多了个不该有的元素」应先**枚举该区域全部渲染者 + 逐个读 render gate**，
  别重放用户时序（重放 6 轮没复现，枚举一轮定位）——已记入 `LESSONS.md` §4.28 与规范 §13.8。**下个 session 从这里开始。**）
- `docs/HANDOFF-2026-09-18-preset-collision.md` — 上一份交接（打包态「两个 preset 相撞」待打通）
  （2026-09-18 夜场，用户换会话继续排查：**首要任务 = 打通「打包态同一进程挂两个不同 preset 必挂」**
  —— 切换自定义模型/resume 会话时报 `command "goal" is already registered`（全局层分支），而官方给每个
  preset 各自 standing scope；判据矩阵：dev 态同序列两 preset 都 OK（打包特有）、全新进程单独挂任一 preset
  都 OK（需两个 preset 共存）、闭包内相关包各只 1 份同版本（已排除「两份模块实例」）。文件内含**复现探针、
  复位命令、守卫清单、纪律禁区（验证类操作会改变被验证对象，验完必须复位）**，以及本场 15 个提交的分主题索引。
  打包链路的原理与修法细节见同日的 `docs/HANDOFF-2026-09-18-packaging-pipeline-and-perf.md`。**下个 session 从这里开始。**）
- `docs/HANDOFF-2026-09-18-packaging-pipeline-and-perf.md` — 同日上一份交接（打包链路：闭包缺官方包的真凶、
  闭包补齐/去重/断言、两个审计脚本；编排归因修复与跳转按钮亦在其中汇总）
  （2026-09-18 打包链路场：用户定调「一定要把打包做好，不然开发了不能发布没有意义」。
  **打包版起不了 agent 的真凶** = `pnpm deploy --legacy` 物化的闭包**系统性缺官方包**
  （工作区 208 个官方包里缺 35 个，因为它们在官方侧多为 peer/devDependency，而打包用
  `--prod --auto-install-peers=false`）；而 `.app` 在仓库里让 Node 从**工作区**补上缺包 ⇒ 能跑但
  **两棵树模块实例混用** ⇒ `dsh-scope` 的 `kScope` symbol 被切成两份 ⇒ `agent-presets: refusing to
  compose an unscoped context` ⇒ agent 挂载失败 ⇒ **整套 MCP 每秒重启**（CPU 高、下拉卡死的因）。
  修法 = 闭包按「工作区实际装了什么」补齐 + 去重 + 两个审计脚本 + 打包期断言。同一份交接还含
  **编排归因修复**（guest 轮次禁用 mtime 并集兜底）与 **agent 重建风暴护栏**。**下个 session 从这里开始。**）
- `docs/HANDOFF-2026-09-16-verify-gate-enforcement.md` — 上一份交接（verify 门禁场，已收口）
  （2026-09-16 verify 门禁场：接续上一份的 §2 遗留项并**收口**。根因 = 声明式 verify **从未进机制
  门禁**——`corumIntegrationTruth` 只判「分支是否进 HEAD」，而集成者用普通 `git merge` 时
  **合并提交自己就进了 HEAD**，故 verify 的 exit 1 被完全忽略；对照会话只因集成者恰好用了
  `--no-commit` 才被拦住 ⇒ 成败取决于子 Agent 偶然选的 git 命令。修法：机制自己跑声明并取退出码 +
  总判定收成「git 实况 ∧ verify exit 0」一个函数 + 拒绝形态类型化 + 通知不得说谎 + 被拒后解卡。
  **三条教训尤其值得先读**：加 orchestrate 结果字段**必须同步输出 schema**（漏了会被
  `INVALID_TOOL_OUTPUT` 整块吞掉 results，Bug B 的反向形态）、报告里**不许写与现场不符的承诺**
  （「PRESERVED」实测已被回收）、改 persona 前先想它会不会制造**新的卡死形态**
  （`--no-commit` 留下 `MERGE_HEAD` 毒化后续每一轮）。**下个 session 从这里开始。**）
- `docs/analysis/HANDOFF-2026-09-16-day-cards-empty-state-and-design-cleanup.md` — 同日日场交接
  （卡片 8 条缺陷收口 + 代码片段卡重设计（**照抄官方 token 级流式增量高亮**）+ **空态与会话宽度
  解耦重构**（文件独立、两条不变式）+ 设计稿同步与过时件清理。
  **六条教训**：画布态≠磁盘态（附磁盘侧判据）、`turn/end` 的 `reason.kind` 判成败、
  **CSS 自定义属性在声明它的元素上求值**（改上游 token 无效）、字体简写 token 不能当字族列表、
  删掉的节点不能在同一次 `execute` 里再引用、`.md` 在编辑器里是预览故没有 `.monaco-editor`）。
- `scripts/audit-dsw-tokens.py` — 设计 token 对账器（按官方 `design-platform.css` + corum
  `theme-layer.ts` 建权威表，列出「不存在的 token」与「多余 fallback」）。改 CSS token 前后各跑一次。
- `docs/analysis/HANDOFF-2026-09-16-card-batch-closeout-and-token-audit.md` — 同日凌晨场交接
  （卡片批次收口 + 纠正上一份交接的事实错误（pen 画布态 ≠ 磁盘态）+ 子任务被限流打断的判据
  + 全库设计 token 对账（12 个不存在的名字 / 硬编码 fallback 归零）+ 两份可复跑声明式规格进仓）。
- `docs/analysis/HANDOFF-2026-09-15-night-card-fidelity-isolation-and-settings.md` — 上一份交接
  （2026-09-15 夜场：卡片整改与设计稿对照 + 隔离漏洞补漏（父树未提交致静默失真 / 收口强制提交）
  + `llm-pi-ai` 段注册失败的根因（settings.yaml 里 `off` 被写成布尔 `false`）与两道防线
  + corum-dev 档案修复（conductor→standard）与技能绑定 + 派发了会话 `corum-task-7be7c4b2`）。
- `docs/analysis/HANDOFF-2026-09-15-unified-project-model-implementation.md` — 上一份交接
  （2026-09-15 统一存储/项目模型**实施**场：`type` 字段贯通 + 三条不变式与判定表 + 统一会话索引
  （`sessionId` 作键 —— 修正了原计划会静默丢 82.9% 的复合键形态）+ 泳道复用修复 + 存量迁移）。
- `docs/analysis/HANDOFF-2026-09-14-night-agent-capability-and-project-model.md` — 上一份交接
  （2026-09-14 深夜场：六条工作方式纪律 + Agent 能力核查 + **存储/项目组织模型定稿**）。
- `docs/analysis/HANDOFF-2026-09-14-supervised-rounds.md` — 上一份交接
  （2026-09-14 监督式委派轮：八条硬纪律 + 本场交付 + 待办队列）。
- `docs/HANDOFF-2026-09-12-session-orchestration.md` — 上一份交接（2026-09-12：
  第四轮交付真机验穿 + BUG-26/27/30~35、编排卡状态机（队列中/集成中/已集成/待集成/集成失败）、
  隔离台账 durable 判据与「并行工作区」栏分档、通知栏列表与浮窗解耦、浮窗可关、
  ui-verify 装置升级）。
- `docs/HANDOFF-2026-09-10-tray-and-notification-ownership.md` — 通知归属分档（全局只进主窗 /
  浮窗留直接反馈 toast + macOS 托盘常驻：菜单栏未读数字、关窗隐藏、单实例锁）。
- `docs/HANDOFF-2026-09-10-session-bar-and-notifications.md` — 上一份交接（会话条
  Agent 胶囊 + 通知 5s 收起 + P8 卡片按次锚点 + P1/P2/P4/P10 修复）。
- `docs/plugin-template.md` — new-plugin package template and setup steps.
- `.dbg/cordis-singleton-probe.md`, `.dbg/c3a-sidebar-mode-service.md` — the
  cordis cross-bundle singleton proof + the sidebarMode service implementation
  record (the slot-registry service reuses the same pattern: provide + inject +
  uSES source + InjectFace).

