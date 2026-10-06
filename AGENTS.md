# corum Agent OS — 开发约定（每个 session 自动注入）

> 本文件由 dsh agent-instructions 在每个新 session 自动注入。它只放**红线 + 入口**：
> 它会出现在每一轮上下文里，**长度即成本**。要加内容先问「它需要每轮都知道吗」，
> 不需要的进 `docs/` 并在下面留一行指针。

本仓是 **corum Harness**——DeepSeek Harness（dsh）运行时的发行版与桌面产品
（Electron 壳 + 41 个插件，按 `ui` / `session` / `agent` 分组）。
产品全貌见 `README.md`；fork 差异台账与官方升级 runbook 见 `docs/fork-delta.md`。

## 红线（先读这 5 条）

1. **跨 bundle 共享状态一律用 cordis service**，不用 window 全局、不用模块级单例。
   dsh 会把 `@corum/*` 源码内联进每个消费 bundle ⇒ 模块级 / window 状态按 bundle 各持一份、
   永不合并（`__corumSidebarMode` 就是这样退化成死写入并断掉侧栏联动的）。
   cordis service 实例的唯一性由根 context 的 `reflect.store` 保证，**天然跨 bundle 单例**；
   共享状态建模为 provide + inject，不需要任何外部化。
   - 合法的 window 挂载（都是「写成一次、只读」，不是共享可变状态）：`window.corumDesktop`
     （IPC 桥）、`__corumNotify`、`__DSH_BOOT__`（唯一客户端读路径）、`__corumSlotRegistry`
     （`ui-base/grid.ts` 的无 cordis 交接点——删掉它会破掉 slotRegistry 单例）。
2. **不要顺手把 `@corum/*` 外部化**：dsh 的 module table 只有 8 个硬编码 seed，走 `dsh.client`
   插件路径共享自定义模块会让应用**白屏**。用第 1 条的 cordis service 绕过。
3. **跨 bundle 类型面不一致 ⇒ 用本地能力接口收窄**：消费者 inject 到的 service 类型可能只是
   官方基线的窄接口（corum 运行时是超集）。不要耦合实现包，用能力接口 + helper 收窄
   （例：conversation 的 `SidebarModeCapableLayout`）。
4. **消费 cordis service 一律走 `inject` 声明**，不要对未装配的 service 用 `ctx.get`
   （`ctx.remote` 坑）。
5. **host 插件改动必须重启应用**，只有 renderer 改动走 HMR。任何跨包状态 / shell / 调度器改动
   都要过实机 CDP 三层验证（UI 渲染 + 行为 + 零 console 错误）。**「编译过」不是「做完」。**

## 验证入口

```bash
pnpm install
pnpm typecheck     # 42 个包，必须 0 错
pnpm build         # 必须在 test 之前：测试要解析 workspace 包构建出的 lib/ 产物
pnpm test          # 100 个测试文件 / ~1950 用例
pnpm guard         # fork drift：与官方检出逐字节比对 + 事件声明↔allowlist 双向 + 挂载点 + inline-css
pnpm ci            # = typecheck && test && guard
```

CI（`.github/workflows/ci.yml`）在 **`macos-latest`、`ubuntu-latest`、`windows-latest` 三个平台**跑同一组五步
（install → typecheck → build → test → guard，`fail-fast: false`）。checkout 必须
`fetch-depth: 0`——`fold-equivalence.spec.ts` 要读 git 历史。

## 平台

目标平台是 **macOS 与 Linux**（一等公民）。**Windows 已适配**（2026-10-06，见
`docs/fork-delta.md` §20），有已知降级：
- **沙箱强制完备性为 `partial`**（vs macOS Seatbelt 的 `full`）——NTFS 硬链接可把已授权
  workspace 文件 alias 到工作区外，Windows 后端只强制 ACL 可表达的剩余面，产品文案须明示；
- **`windows-acl` runner 只接受单个 `--workspace` 根**——隔离子 Agent 的 git 提交在 Windows
  上暂不可用（指挥模式多 Agent 隔离 worktree 功能性缺口）；
- **symlink 物化需开发者模式 / admin 权限**——打包链路已改用 junction + 解引用复制绕开。

Windows 已纳入 CI 矩阵（`windows-latest`）。能平台无关表达的用例一律改表达式；
平台相关的已知降级用 `it.skipIf(process.platform === 'win32')` 并在注释里点名对应降级项。

## 工作纪律

- **「编译过 + 测试绿」不能收口**：`tsc -b` 是增量编译会藏破坏点（判定重构必须 `--force`）；
  实测一个 `return undefined` 被删掉后编译与测试都发现不了，只有 `git diff` 对照 HEAD 拦得住。
- **修根因，并检查每一个同级调用方**：报障给的是症状；改之前 grep 该函数的全部调用者——
  在共用函数里加一个守卫比在每个调用方各加一个更小、也更完整。
- **判据变红不等于该降标准**：修法是扩大取样面 / 按文件逐处断言，不是调阈值。
- **归因有争议时用对照实验，不要推理**：手动调一次 `answer()` 面板立刻消失 ⇒ 一次实验同时
  排除两条假设。
- **状态与策略是两条轴**：两个方法各自写同一份状态（权限档位 vs 指挥模式）就是 bug，
  补 if 无用，必须收成单一写入者。
- **在对话里说过「要做 / 该修」的事必须落进文件**，否则下一次上下文压缩即丢失。
- **实机验证不可替代**：编译期发现不了的问题只能靠真机看（打包闭包缺包、历史会话缺字段
  都是这么抓出来的）。
- **带 corum 定制的文件禁止整文件覆盖**：必须逐处三方合并；整文件拷官方版会静默还原定制
  （`TurnNavigator.module.css` 圆点刻度事故），且 typecheck / build / console 全绿也发现不了。

## 文档位置

**在本仓**：
- `README.md` — 产品全貌、插件分组、目录布局。
- `docs/fork-delta.md` — fork 台账（16 个 fork 包）+ 官方升级 runbook（动 fork 包前必读）。
- `skills/corum-dev-conventions/SKILL.md` — 本文件的**可执行投影**（红线 / 改动工作流 / 已付学费的坑 / 证据标准）。
  改规范时**先改本文件，再同步这份技能**。
- `skills/corum-official-upgrade/SKILL.md` — 官方基座升级的可执行投影。
- `scripts/` — 守卫与审计工具（`verify-fork-drift.sh`、`verify-refactor-guard.sh`、
  `audit-dsw-tokens.py`、`corum-instance.sh` …）。
- `docs/archived-upstream-index.md` — 上游规则 / 交接文档的**索引存档**。

**不在本仓**：上游的规则与经验库（`dev-conventions.md`、`LESSONS.md`、`VERSIONING.md`、
`plugin-template.md`、`DBG-ARCHIVE-INDEX.md`、`audit/*`、`PLAN-*`、`HANDOFF-*.md`）**被
`.gitignore` 的 `docs/` 规则排除在外**（该目录只显式放行 `fork-delta.md` 与 `assets/`；
`git log --all -- docs/` 为空）。需要原文请向上游开发检出索取——**不要按这些路径找文件**
（找不到不是缺文件，是没被分发）。

## Repo 速查

- 插件在 `packages/plugins/<group>/<name>`（组 `ui` / `session` / `agent`，当前 14 / 11 / 16 = 41 个）；
  桌面壳是 `packages/desktop`。新增插件必须**同时**登记进 `packages/desktop/package.json` 与
  `packages/desktop/desktop-host/package.json`（打包闭包按后者补齐），并 `pnpm install` 链接。
- 单包构建：`pnpm --filter <name> run build`（先构建 `ui-base` 等依赖包）。typecheck 用同样的 filter。
- **两个检出，别混**：本仓是 corum fork（你要编辑的工作树）；用于对照的官方 dsh 检出在别处
  （作者机上为 `/Users/kukucai/dsh`，请按你的实际检出替换；fork 差异表的对照基线是 tag
  `dsh-v0.1.3-alpha.1`）。官方包源码（`packages/core`、`packages/api/*`、`packages/client/*`、
  `packages/subagent/*`）**只**存在于那边 ⇒ 在本仓里这类相对路径是**路径错误，不是空结果**。
  fork 源码在本仓 `packages/plugins/**`（映射台账：`docs/fork-delta.md`）。
- fork drift 守卫：`./scripts/verify-fork-drift.sh`——任何 fork 或事件改动后都要跑。没有
  `DSH_CHECKOUT` 时逐字节断言会跳过（逐条标注），事件一致性 / 挂载点 / inline-css 断言仍执行。
- 实机验证 / CDP：`./scripts/corum-instance.sh start|status|stop`（`--home=dev` 主实例 :9222；
  `--home=verify` 隔离验证实例 :9333；`--mode=packaged` 打包态）。
