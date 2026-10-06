<p align="center">
  <img src="packages/desktop/assets/icon.png" alt="Corum Harness" width="160">
</p>

<h1 align="center">Corum Harness</h1>

<p align="center">
  基于 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 底座构建的
  <b>通用 Agent 软件</b>——把 agent loop、工具系统、多 Agent 编排、记忆、技能打包成开箱即用的产品，
  面向编程场景与通用 Agent 场景。
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-blue">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-11.7.0-orange">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="Status" src="https://img.shields.io/badge/status-early%20development-yellow">
</p>

<p align="center">
  <b>📣 进交流群</b>：微信扫码加入「Corum 交流群」，反馈问题、共建工作流<br>
  <img src="docs/assets/wechat-group-qrcode.webp" alt="Corum 交流群二维码" width="200">
  <br>个人微信：<b>hjkkclife</b>（备注 corum，欢迎交流共建）
</p>

---

## 这是什么

Corum Harness 把 DeepSeek Harness 从一个 **Agent 运行时**，扩展成一个**可直接使用的 Agent 产品**：
dsh 运行时内核 + Electron 桌面承载层 + 41 个自研插件 + 一套默认配置。

> **定位类比**：DeepSeek Harness 是「Linux 内核」（Cordis 插件框架 + agent loop + capability seam），
> 本项目是「发行版」（产品化的 Agent 能力 + 插件 + 默认配置）。**不改内核，只做用户空间。**

底座能力（context 管理、工具系统、LLM 适配、会话存储、subagent 机制）全部继承自 dsh；
本项目的价值集中在**把 Agent 能力做成可直接使用的产品**——编程助手是最先落地的场景。

---

## 核心能力

- **多 Agent 编排**：`orchestrate` 声明式 fan-out；子 Agent 在独立 git worktree 中工作并自动集成；
  子 Agent 卡片可见可控，编排进度一目了然。
- **指挥模式（Conductor Mode）**：「一个技术负责人带一支队伍」的基础模式
  （`baseMode: 'conductor'`，与 `standard` / `ptc` / `minimal` / `cordis` 并列）：
  - 指挥者是技术负责人，不是调度员——判断问题是什么、该怎么解、结果是否真的达标；
  - 恒只读：不给写工具、只给只读 shell，约束走机制层门禁，用户权限档位只对 worker 生效；
  - 三阶段调研：入门自己看（有界）→ 深入交给 research 子 Agent → 收尾只做点读验收；
  - 子 Agent 的报告是**主张**不是证据，验收必须亲自看 diff。
- **Agent 预设（persona）**：岗位、人格、职责、域边界、模型路由（主 / 子 / 调查三档独立配置）。
- **记忆底座**：事实级存储、存续期与衰减，设置中心可配。
- **MCP 集成**：MCP 服务管理与授权，工具自动装配进 Agent。
- **技能库**：可绑定的可复用技能（含项目自带开发规范技能）。
- **本地模型**：支持 Ollama 等本地 provider，云端 / 本地随配置切换。
- **文生图**：本地文生图能力（`corum-artgen`）。
- **编程工作台**（编程场景的落地形态）：Monaco 编辑器 + 文件树 + 终端 + 对话区，可拖拽重组。

### 工程化

- **插件化发行**：41 个插件包按 `ui` / `session` / `agent` 分组，能力与界面同包。
- **最小内核侵入**：官方包尽量从 npm registry 原样引用；必要的定制集中在 **16 个 fork 包**
  （修补底座在上层暴露的能力缺口），差异全部登记在 [`docs/fork-delta.md`](docs/fork-delta.md)
  并由 `scripts/verify-fork-drift.sh` 守卫字节级一致性——其余定制仍通过「写插件 + overlay 覆盖行」完成。
- **可验证性优先**：CDP 实机验证技能 + 声明式断言跑器，界面改动必须跑真机三层验证
  （渲染 / 行为 / 零控制台错误）。

---

## 快速开始

**环境要求**：Node `^22.19.0 || >=24.0.0`，pnpm `11.7.0`。

```sh
pnpm install
pnpm shell:dev        # 开发态启动桌面应用
pnpm pack             # 打包桌面应用（macOS .app/.dmg；Windows NSIS 见 docs/fork-delta.md §20）
```

> **平台说明**：目标平台为 **macOS 与 Linux**（一等公民，全量能力）。**Windows 已完成适配**
> （2026-10-06，见 [`docs/fork-delta.md`](docs/fork-delta.md) §20），开发态可启动、可产出
> NSIS 安装包、`windows-latest` 已纳入 CI 矩阵。已知降级：
> - **沙箱强制完备性为 `partial`**（vs macOS Seatbelt 的 `full`）——NTFS 硬链接可把已授权
>   workspace 文件 alias 到工作区外，Windows 后端只强制执行 ACL 可表达的剩余面，产品文案须明示；
> - **`windows-acl` runner 只接受单个 `--workspace` 根**——隔离子 Agent 的 git 提交在 Windows
>   上暂不可用（指挥模式的多 Agent 隔离 worktree 功能性缺口）；
> - **symlink 物化需开发者模式 / admin 权限**——打包链路已改用 junction + 解引用复制绕开。

### 构建与检查

```sh
pnpm build          # 全量构建（packages/**）
pnpm typecheck      # 全量类型检查
pnpm shell:smoke    # 冒烟启动

# fork 与官方基线的漂移守卫（改 fork 包后必跑）
./scripts/verify-fork-drift.sh
```

---

## 仓库结构

```
packages/
├── desktop/                  # Electron 桌面承载层（壳 + 宿主桥 + 打包）
│   ├── src/host/              #   host 侧：桥接、IPC、打包闭包
│   ├── src/client/            #   renderer 侧：壳、编辑器、布局
│   └── assets/                #   品牌与图标资源
└── plugins/                  # 41 个插件包，按能力分组
    ├── ui/        (14)        #   界面区域：面板、插件中心、主题基座
    ├── session/   (11)        #   会话与交互：对话、审批、提问、模型选择
    └── agent/     (16)        #   Agent 能力：编排、子 Agent、记忆、MCP、工具

profile/corum/                # 发行版 profile 清单
cordis.patch.yml              # 发行版 overlay（覆盖官方默认行 + 插入插件行）
docs/                         # fork 差异台账与开源资产
scripts/                      # 开发 / 验证 / 打包 / 审计脚本
skills/                       # 项目自带技能（开发规范、CDP 实机验证）
```

**插件是怎么被加载的**：每个插件包自带 `cordis.patch.yml` 声明挂载行，发行版
`cordis.patch.yml` 只放跨包覆盖；新增插件须同时登记进 `packages/desktop/package.json`
与 `packages/desktop/desktop-host/package.json`（打包闭包按后者补齐，遗漏会导致
**仅打包态**功能缺失）。

---

## 插件开发

新增一个插件 = 在 `packages/plugins/<组>/` 下建包 + 在 overlay 加一行。
fork 差异台账见 [`docs/fork-delta.md`](docs/fork-delta.md)（改 fork 包前必读）。

### 三条必须知道的红线

1. **跨 bundle 共享状态一律用 cordis 服务**，不要挂 window 全局或模块级单例
   （bundle 各自内联 `@corum/*` 源码，模块级状态会被复制成多份且永不收敛）。
2. **不要随意 external 化 `@corum/*`**：底座的共享模块表只有 8 个硬编码种子，
   自建共享模块走 `dsh.client` 路径会导致白屏——用 cordis 服务绕开。
3. **host 插件改动必须重启应用**（renderer 改动才走 HMR）；跨包状态 / 壳 / 调度器
   改动必须过 **CDP 实机三层验证**（UI 渲染 + 行为 + 零控制台错误）。
   **「编译通过」不等于「做完了」。**

---

## 与 DeepSeek Harness 的关系

| | DeepSeek Harness | Corum Harness |
|---|---|---|
| 角色 | Agent 运行时内核 | Agent 产品发行版 |
| 提供 | Cordis 框架、agent loop、工具系统、capability seam | Agent 能力产品化、41 个插件、默认配置 |
| 依赖方式 | — | 大部分从 npm registry 引用官方包（`@deepseek-ai/dsh-*`）；另维护 **16 个 fork 包**修补能力缺口 |

本项目维护 16 个 **fork 包**（用于修补底座在上层暴露的能力缺口），差异全部登记在
[`docs/fork-delta.md`](docs/fork-delta.md)，并有 `scripts/verify-fork-drift.sh` 守卫字节级一致性。

---

## 开源范围

本项目采用 **open core** 模式：

- **开源（本仓库）**：**任务模式（Task Mode）**——单任务泳道 + 指挥模式 + 完整的 Agent
  能力面（编排、子 Agent、记忆、MCP、技能、编程工作台）。
- **闭源（独立维护）**：**项目模式（Project Mode）**——项目制工作区、多 Agent 团队协作、
  需求 / 任务 / BUG 管理与项目级知识治理。**开源发行版只呈现任务模式**，不提供项目模式入口。

> **剥离已完成（2026-09-27）**：项目模式的实现**已迁出本仓库**，现位于独立闭源仓
> [Corum-Harness-Project](https://github.com/kukucaiCndy/Corum-Harness-Project)；
> **本仓库为纯任务模式的开源形态**（侧栏不再出现「项目」tab，无相关依赖与挂载行）。
> 若要构建含项目模式的闭源形态，需把闭源仓的插件（`@corum/corum-project` 等）经 cordis patch
> 挂载到本仓之上，具体步骤见该仓的 README。历史规划文档已不入库。

## 项目状态

**早期开发阶段**，接口与配置仍在快速演进，尚未发布稳定版本（当前 `0.1.0`）。
欢迎通过 Issue 反馈问题与建议。

## 许可证

[Apache License 2.0](LICENSE)。

选择 Apache-2.0 而非 MIT 的原因：它**显式授予专利许可**（第 3 节），对商业使用与
企业贡献者更友好，同时保留商标条款（第 6 节）。上游 DeepSeek Harness 为 MIT，
与本许可证兼容。

## 致谢

本项目构建于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与
[Cordis](https://github.com/deepseek-ai/cordis) 之上，感谢底座团队的工作。
