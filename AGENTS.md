# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

> 本内容填在仓库根 `AGENTS.md`：`/init` 检测到根 `AGENTS.md` 已存在（0 字节空文件），故按约定不另建 `CODEBUDDY.md`，直接把本文件填充为 agent 指引。仓库文档 / 注释 / 提交信息以中文为主，本指引同。

## 先读这几处（入口索引）

- `README.md` — 产品定位、插件加载与红线、仓库结构、平台矩阵。
- `docs/fork-delta.md` — fork 台账 + §5 升级 runbook（**改 fork 包前必读**；先看它文首的「基线滞后」「路径分三类」标注）。
- `skills/corum-dev-conventions/SKILL.md` — 改动工作流 / 红线 / 已付学费的坑（规则的唯一家是上游未分发的 `docs/dev-conventions.md`，本仓以该技能为准）。
- `skills/corum-official-upgrade/SKILL.md` — 升级官方 dsh 基座的完整手册。
- `docs/archived-upstream-index.md` — 上游文档索引（**本仓不存在的路径不要去"找"**）。

仓库路径分三类：`packages/**`、`scripts/**`、根 `cordis.patch.yml` 等本仓路径存在且可直接读；`/Users/kukucai/dsh/**` 是**官方对照检出**（本仓里写这类路径 = 路径错误，不是空结果）；`docs/dev-conventions.md`、`docs/LESSONS.md`、`docs/tasks/log.jsonl` 等被 `.gitignore` 的 `docs/*` 规则排除，`.dbg/**` 则为已随上游提交移出工作树、本机只余可再生成笔记的目录。文中引用这些未随仓分发的路径都只是历史锚点。

## 常用命令

环境：Node `^22.19.0 || >=24.0.0`、pnpm `11.7.0`。根级 `scripts/*.sh` 是 bash 脚本，Windows 请在 Git Bash 里跑。

**依赖与构建**

- `pnpm install` — 安装全工作区依赖。改过 `pnpm-workspace.yaml` overrides 后须加 `--no-frozen-lockfile`；无 TTY 时前置 `CI=true`。
- `pnpm build` — 全量构建 `packages/**`。插件产物 = `tsc -b`（只写 `lib/types/*`）+ `tsdown`（生成运行时真正加载的 `lib/index.js` / `lib/client.js`）；**UI 插件包构建三步缺一不可**（`tsc -b && tsdown && node scripts/inline-css.mjs`，只跑 tsdown 会把 CSS 抽成外部 `lib/style.css` ⇒ dev 运行时 404、界面裸奔）；桌面壳另含 Monaco CSS 内联。**改完插件必须重新 build 并核对产物时间戳**（旧产物会静默生效）。
- `pnpm typecheck` — 全量类型检查。⚠️ `tsc -b` 是增量编译、会藏住依赖升级造成的破坏点；依赖变动后用 `pnpm -r --no-bail typecheck --force` 复核。
- `pnpm ci` — `typecheck && test && guard` 三连（本地复刻 CI）。

**测试**

- `pnpm test` — 全仓 vitest。**必须先 build**：测试解析 workspace 包的 `lib/` 产物，未构建会报 `Failed to resolve entry for package "@corum/..."`。
- 单包测试：`pnpm --filter @corum/corum-memory run test`。
- 单文件测试：`pnpm --filter @corum/corum-memory exec vitest run tests/memory-service.spec.ts`（桌面壳换成 `--filter corum-desktop`）。
- `corum-agent/tests/fold-equivalence.spec.ts` 依赖 git 历史，浅克隆会 fail —— 不要 shallow clone。

**运行 / 打包**

- `pnpm shell:dev` — 开发态启动桌面应用（入口 `packages/desktop/lib/cli.js`；首次/改动后需先 `pnpm build`）。
- `pnpm shell:smoke` — 无头握手冒烟。
- `pnpm run pack` — 打包桌面应用（macOS：.app/.dmg；Windows：NSIS）。内部按 `build` → `pack:host` → `pack:node` → `pack:app` 顺序。⚠️ **必须带 `run`**：`pnpm pack` 是 pnpm 内置命令（Create a tarball from a package），不会执行同名脚本。
- Windows 开发态：`powershell -File packages\desktop\scripts\dev.ps1 [--combo=coding]`（稳定 dev home + HMR；cmd 入口 `dev.cmd`）。

**守卫 / lint / 发布**

- `pnpm guard` — 全量 fork-drift 守卫（20 个分区：fork 核心文件逐字节一致、事件声明 ↔ 转发 allowlist 双向、客户端插件挂载点覆盖、pnpm overrides 闭包版本一致等）。**验收只认无参数全量**；`--fast` / `--only` 仅供开发迭代。字节比对需官方检出：`DSH_CHECKOUT=<dsh 检出> DSH_BASELINE_TAG=dsh-v0.1.5-rc.3 ./scripts/verify-fork-drift.sh` —— 环境变量没给全时字节断言会**静默 skip**，数 skip 再看"绿"。
- `pnpm exec oxlint packages/ scripts/` — lint（advisory，CI 里 continue-on-error；配置 `.oxlintrc.json`）。
- `./scripts/check-fork-increments.sh --list` — 打印全部 18 个 fork 包 ↔ 官方检出路径映射；三参形式（corum 目录 / 官方路径 / tag）做「官方行零缺失 ∧ 增量全在」双向逐文件验收。
- `./scripts/regenerate-dsh-overrides.sh [--check | --write --target <ver>]` — dsh overrides 与实装集合的对齐检查 / 整块重生成（防打包闭包混版）。
- `./scripts/verify-refactor-guard.sh` — corum-agent 架构拆分的不变式守卫。
- `node scripts/release.mjs [--write] [--bump=minor]` — 版本递增 + TOP5 更新日志 / 注意事项（= `pnpm release`）。

**实机验证（CDP）**

- `./scripts/corum-instance.sh start --home=verify` — 起隔离验证实例（CDP :9333）。**绝不驱动或杀掉用户主实例（:9222）**；应用禁止在 agent 沙箱内启动（`scripts/app-launch-guard.sh` 拦截，这不是产品 bug）。
- `node scripts/ui-verify.mjs spec.json` — 声明式 UI 断言跑器（渲染 / 行为 / 截图，任一断言失败非零退出）；单点操作配 `scripts/cdp.mjs`、`cdp-click.mjs`、`cdp-reload.mjs`。

## 架构

### 定位：dsh 内核上的"发行版"

Corum Harness 基于 DeepSeek Harness（dsh）底座：dsh 提供 Cordis 插件框架、agent loop、工具系统、capability seam（作为 `@deepseek-ai/dsh-*` npm 包引用）；本仓只做**用户空间**——41 个自研插件包 + Electron 桌面壳 + profile / 默认配置。原则是**不改内核**：定制通过「写插件 + cordis patch 行覆盖 / 插入」完成；少数底座能力缺口用 **fork 包**整包替换官方同名包（如 `@deepseek-ai/dsh-tools` → `link:packages/plugins/agent/corum-tools`、`dsh-fs-local` → `corum-fs-local`，见 `pnpm-workspace.yaml` overrides）。

### 启动拓扑（三个进程）

1. **Electron 主进程 / 壳**（`packages/desktop/src/electron/`）：combo 管理器。读 `~/.corum-desktop/combos.json`（内置 IDE/coding combo），按所选 combo 以**系统 Node** spawn 一个 host 子进程（`CORUM_HOST_NODE` 由 cli 传入）；不做进程内插件增删，**切换 combo = 换 host 进程**。壳另负责原生能力：preload/IPC、托盘、deep link、safeStorage 封装凭据主密钥等。`lib/cli.js` 启动前会剥掉 `DSH_*` / `ELECTRON_RUN_AS_NODE` 等宿主环境变量。
2. **host 子进程**（`packages/desktop/src/host/boot.ts` 及同目录服务）：用 `@deepseek-ai/dsh-app-boot` 启动 dsh `web` profile，把桌面 overlay 作为最高 patch 层叠加；绑定 `127.0.0.1:0`（临时端口），把带鉴权的 URL 报给壳。host 侧还有 corum 专属服务：fs、terminal、git、review、plugin-manager、session-archive。
3. **渲染层**（`packages/desktop/src/client/` + 各插件 client 半）：Electron 窗口直接 `loadURL` 官方 web surface 的 authenticatedUrl，**没有自建 IPC 传输**；桌面专属 UI 由 corum 插件注册进官方槽位（如 `corum.editor`）。

### Cordis patch 分层（进组合的唯一入口）

自下而上：bundle 栈（`profile/corum/package.json` 的 `dsh.profile.bundles` = `dsh-base` → `dsh-web-app` → `corum-desktop`）→ 各层自带 `cordis.patch.yml` → home 级 patch → **桌面 overlay** → combo 的 `patches`（最高层）。要点：

- 本仓**插件挂载行集中在 `packages/desktop/cordis.patch.yml`**（IDE 模式另加 `cordis.ide.patch.yml`，由 `CORUM_DESKTOP_MODE=ide` 触发）；根 `cordis.patch.yml` 只放发行版级跨包覆盖。
- 行覆盖纪律：**禁官方行（`disabled: true`）+ 在 `insert` 段以不同 id 挂 fork 行**（同层 load id 唯一性由 loader 强制）；**cordis 服务名保持不变**，消费方 `inject` 零感知。⚠️ 顶层新增行**永远不会进 composition**，必须写进 `insert` 块。
- 新增插件 = 在 `packages/plugins/<ui|session|agent>/` 建包 + 在 desktop patch 加挂载行 + **双登记** `packages/desktop/package.json` 与 `packages/desktop/desktop-host/package.json`（打包闭包按后者补齐，漏登记 = 仅打包态功能缺失）。client bundle URL 是 `/plugins/<行 id>/client.js`，**行 id 用短 id**（不含 `/`）。

### 插件包形态

每个插件是标准 npm 包、双半结构：host 半 `lib/index.js`（provide cordis 服务 / 挂行），client 半 `lib/client.js`（在 `package.json` 的 `dsh.client` 块声明 `platform: web`、`inject`、`external`、`immediately`）；可用子路径导出挂多个行（如 `./settings-registrar`、`./spawn`、`./isolated`）。构建 = `tsc -b && tsdown`（个别包再加 `scripts/inline-css.mjs`）。分组：`ui/` 14 个（编程工作台、插件中心、IDE 壳、主题基座）、`session/` 11 个（对话渲染、审批、提问、模型选择、设置页）、`agent/` 16 个（编排、子 Agent、记忆、MCP、技能、工具，及 fs / sandbox / credentials / tools 等 fork）。`packages/desktop/desktop-host/` 是**纯依赖部署根**（只有 package.json）：为打包闭包列出运行时要解析的全部包，无源码。

### fork 包与守卫

- 清单以 `scripts/check-fork-increments.sh --list` 为唯一事实源（当前 **18 个**；README / 台账里 16 等历史口径可能滞后）。台账 `docs/fork-delta.md` 逐文件登记差异分类与 rebase 风险；其 §1–§4 对照基线停在 `0.1.3-alpha.1`，但字节一致面已由 CI 对齐 `0.1.5-rc.3`。
- 纪律：fork 包「**核心文件逐字节等于官方 + 增量只加在声明位置**」；升级手法「**官方目标版文件为底 + 贴回 corum 增量**」，增量标记为 `fork（corum）` / `CORUM-PATCH` 注释；**UI 类 fork 只升依赖、`src/client/**` 不合并**（官方 UI 改动按我们的视觉风格借鉴重做）。
- `pnpm guard` 是招牌守卫，分区覆盖：字节一致（[1][5]）、事件声明 ↔ allowlist ↔ host emit（[2]-[4]）、inline-css、挂载点覆盖（[8]）、模型选择单一 owner、GPU 合成、打包闭包版本一致（[13]）、沙箱可写根等。
- 基座升级：每个包「**包声明 + 根 `pnpm-workspace.yaml` overrides 同步改**」→ install → typecheck → build → 提交（`^` 范围会静默带走未升级的共享依赖 ⇒ 白屏，见升级技能）。

### 三条红线（违反即回滚）

1. **跨 bundle 共享状态一律用 cordis 服务**，不要挂 window 全局或模块级单例——`@corum/*` 源码被 inline 进每个 bundle，模块级状态会分裂成多份且永不收敛。
2. **不要随意 external 化 `@corum/*`**：底座共享模块表只有 8 个硬编码种子，自建共享模块走 `dsh.client` 路径会白屏——绕行方案就是红线 1。
3. **host 插件改动必须重启应用**（只有 renderer 走 HMR）；跨包状态 / 壳 / 调度器改动必须过 **CDP 实机三层验证**（界面渲染 + 行为 + 零新增控制台错误）。**「编译通过」不等于「做完了」**。

### 平台与工程现状

- 平台：**macOS 一等公民**（打包链路 .app/.dmg）；**Windows 已适配**（`docs/fork-delta.md` §20）：win32 平台分派（`powershell.exe`、路径归一、junction 物化）、`dev.ps1`、NSIS 打包、CI `windows-latest`。已知降级：沙箱强制完备性 `partial`（NTFS 硬链接面）、`windows-acl` runner 只接受单个 `--workspace` 根（隔离子 Agent 的 git 提交在 Windows 上不可用）。
- 平台纪律（`docs/windows-adapter-plan.md` 按此验收）：能平台无关表达的用例一律改表达式；平台相关的已知降级用 `it.skipIf(process.platform === 'win32')` 并在注释里点名对应降级项。
- 版本双线：应用版本（`0.2.0`，根 `package.json`）与 dsh 基座版本（`0.1.5-rc.3`，`pnpm-workspace.yaml` overrides 逐个钉死）分开维护；`pnpm-workspace.yaml` 里的 overrides 列表 = 工作区实际安装的 dsh 包全集，bump 时用 `regenerate-dsh-overrides.sh` 整体对齐。
- CI（`.github/workflows/ci.yml`）：macOS + Linux + Windows 三平台跑 `typecheck → oxlint(advisory) → build → test → guard`；main push 另跑 fork-drift 字节比对 job（clone 官方 tag 检出）。
- 文档事实：`.gitignore` 把 `docs/*` 整个排除，只放行 `docs/fork-delta.md`、`docs/archived-upstream-index.md`、`docs/assets/`；仓库自带技能在 `skills/`（dev-conventions、official-upgrade）。规则的家以这些为准，本文件只做入口索引。
