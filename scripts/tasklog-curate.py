#!/usr/bin/env python3
"""tasklog-curate.py —— `docs/tasks/log.jsonl` 的**元数据 curation 器**（append-only 语义的补写器）。

与 `scripts/tasklog-open.mjs` 的分工：那个是**渲染器/守卫**（只读，`--check` 报冲突），
这个是**收敛器**（写入，只改元数据字段）。

## 为什么是脚本而不是手改
台账 887 行 / 2 MB / 671 key。手改一行就要一次精确锚点匹配，70 行就是 70 次赌；
而且下一次同样的问题还会再来一遍。规则写成表 → 可复核、可干跑、可重复执行。

## 纪律（`tooling.tasklog.write-path` / `tooling.tasklog.curation`）
- **只写元数据字段**（kind/scope/key/value/status/evidence/supersedes/curated/created/author）；
- **绝不改写 `text`**（用户原话与事实叙述不可变）；
- **不删行**（事实是 append-only 的；本脚本只做「补写」与「归一」）；
- `supersedes` 的语义是**取代某个旧的 `value` 字符串**，**不是行 id 也不是 key**
  —— 2026-09-16 那批把 key 填进去的行正是今天 11 组假冲突的成因，本脚本负责拨正。

## 用法
    python3 scripts/tasklog-curate.py --plan    # 干跑：打印将要做出的每一处改动
    python3 scripts/tasklog-curate.py --apply   # 执行（先备份到 docs/tasks/backups/）
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "docs" / "tasks" / "log.jsonl"
BACKUP_DIR = ROOT / "docs" / "tasks" / "backups"

# ---------------------------------------------------------------------------
# 规则 ①：11 组「同 key 异值」冲突 —— 全部是「新决定行了，但 supersedes 没落在
# 渲染器认得的字段上」（填了 key 而不是 value），不是真有两套说法。
# 形状：(key, 新行的 value, 被取代的旧 value 列表)
# ---------------------------------------------------------------------------
SUPERSEDE_FIXES: list[tuple[str, str, list[str]]] = [
    # 2026-09-16 的决定取代 2026-09-12 的口径（前者文本明写「本条的处理口径同时成立」）
    ("settings.placeholder.semantics",
     "unimplemented-features-tracked-in-prd-15", ["future-work-not-removal"]),
    # 2026-09-16 收口 2026-09-13 的命名拍板（前者文本明写「本条收口 131 与 145」）
    ("preset.modes.template-only",
     "template-only-finalized-5-builtin-agents-shipped",
     ["5-builtins-conductor-standard-minimal-ptc-creator"]),
    # 下面 5 组的 supersedes 当初填的是 key 本身 ⇒ 渲染器不认 ⇒ 假冲突
    ("settings.roundtable.result",
     "roundtable-finalized-and-shipped",
     ["roundtable-2026-09-12-result-recovered-10-consensus-7-open-disputes-plan-p0-p1-p2"]),
    ("settings.roundtable.dispute.terminal-agent-loop-form",
     "roundtable-finalized-and-shipped", ["awaiting-user-decision"]),
    ("settings.roundtable.dispute.placeholder-badge-granularity",
     "roundtable-finalized-and-shipped", ["awaiting-user-decision"]),
    ("settings.roundtable.dispute.placeholder-presentation-site",
     "roundtable-finalized-and-shipped", ["awaiting-user-decision"]),
    ("settings.roundtable.dispute.models-front-placement",
     "roundtable-finalized-and-shipped", ["awaiting-user-decision"]),
    # 四条机制级不变式：旧行记「用户定的要求」，新行记「已落地成什么机制」。
    # 同 key 后写覆盖 ⇒ 落地形态即该 key 的当前取值。
    ("invariant.workspace-git-required",
     "git-core-plugin-host-enforced-ensureRepo", ["user-mandated-hard-mechanism"]),
    ("invariant.commit-after-modification",
     "turn-end-forced-commit-parent-tree", ["user-mandated-hard-mechanism"]),
    ("invariant.background-parallel-isolated",
     "background-parallel-writes-always-isolated", ["user-mandated-hard-mechanism"]),
    ("invariant.merge-strategy",
     "orchestrator-integrator-default-on-single-shot-main-agent-merge-notice",
     ["user-mandated-hard-mechanism"]),
]

# ---------------------------------------------------------------------------
# 规则 ②：终态同义状态归一。
# 渲染器只认 `done`/`dropped`（`tasklog-open.mjs:35-36`），而台账用了 72 种 status，
# 其中一批**终态同义词**（resolved/verified/fixed/closed/…）被算作「未关闭」——
# 这不修数据修工具就成了降标准，故把**已是终态**的行归一为 `done`，
# 原状态原文记进 `curated`（可回滚、可追溯）。
# 刻意**不**归一编码中途进度的状态：partial / verified-partial /
# unit-verified-device-unverified / open-recorded-not-fixed / step*-done ——
# 它们字面就写着「没完」，收口是撒谎。
# ---------------------------------------------------------------------------
TERMINAL_STATUSES = {
    "resolved", "verified", "fixed", "closed", "corrected", "not-reproduced",
    "adopted", "confirmed", "done-with-backup",
    "packaged-acceptance-passed", "acceptance-met-dev-instance",
    "verification-green", "goal-metric-met",
}
# 刻意**不**归一（字面就写着「没完 / 等裁决 / 是记录」收口即撒谎）：
#   partial / verified-partial / unit-verified-device-unverified / open-recorded-not-fixed
#   improved-not-solved / inconclusive-for-main-list / unmeasured / planned / doing /
#   in_progress / awaiting-* / ready-for-* / draft-on-canvas / root-cause-* / recorded /
#   done-major / ui-batch-done / step*-done / *-awaiting-user-decision /
#   *-need-decision / e1-shipped-caller-unidentified / done-logic-hard-point-1-of-2

# 规则 ③：逐 key 的显式裁决（形状：key -> (新 status, curated 原文)）。
STATUS_FIXES_BY_KEY: dict[str, tuple[str, str]] = {
    # 同一件事在 `todo.` 与 `ui.` 两个前缀下各有一行且状态互斥（`ui.` 那行的
    # `resolves` 本已指向它，只是渲染器不消费 `resolves`）⇒ 把遗留行收口。
    "todo.mosaic.per-shape-layout": (
        "done",
        "2026-10-06 curation：本条已由 ui.mosaic.per-shape-layout 交付（四种形状分档布局，"
        "1280/1600 两档实测、数据守恒 804 组穷举、入口贴 398/398 全绿），按同 key 收口。",
    ),
}

# 规则 ④：两行缺 `created`/`author`（L558/L559）。据其 `text` 自述为 2026-09-16 收口。
MISSING_META_FIXES: dict[str, tuple[str, str]] = {
    "todo.ui.terminal-card-font-shorthand-as-font-family": ("2026-09-16", "agent"),
    "tooling.ui-verify.specs-broken-before-selector-and-truthy-skip-string": ("2026-09-16", "agent"),
}


def load():
    rows, bad = [], []
    for index, line in enumerate(LOG.read_text(encoding="utf-8").split("\n"), 1):
        if not line.strip():
            continue
        try:
            rows.append((index, json.loads(line)))
        except json.JSONDecodeError:
            bad.append(index)
    return rows, bad


def insert_after(row: dict, anchor: str, key: str, value) -> None:
    """在 `anchor` 之后插入 `key`（保持字段顺序可读；已存在则原地改）。"""
    if key in row:
        row[key] = value
        return
    out = {}
    for k, v in row.items():
        out[k] = v
        if k == anchor:
            out[key] = value
    if key not in out:
        out[key] = value
    row.clear()
    row.update(out)


def plan(rows):
    """返回 [(行号, key, 说明, 变更函数)] —— 纯函数，apply 与 plan 共用同一份判定。"""
    changes = []

    # ① supersedes 拨正
    for key, new_value, old_values in SUPERSEDE_FIXES:
        target = None
        for index, row in rows:
            if row.get("key") == key and row.get("value") == new_value:
                target = (index, row)
        if target is None:
            continue
        index, row = target
        current = row.get("supersedes")
        held = [current] if isinstance(current, str) else list(current or [])
        merged = [v for v in held if v != key and v not in old_values]
        merged += [v for v in old_values if v not in merged]
        desired = merged[0] if len(merged) == 1 else merged
        if desired == current:
            continue

        def apply(row=row, desired=desired, key=key):
            row["supersedes"] = desired
            insert_after(row, "status",
                         "curated",
                         f"2026-10-06 curation：supersedes 拨正为旧 value（原填 key `{key}` 不被渲染器识别，"
                         "故 tasklog-open --check 报假冲突）。")

        changes.append((index, key, f"supersedes ← {desired}", apply))

    # ② 终态同义状态归一
    last_of_key = {}
    for index, row in rows:
        last_of_key[row.get("key")] = (index, row)
    for key, (index, row) in last_of_key.items():
        status = row.get("status")
        if status not in TERMINAL_STATUSES:
            continue

        def apply(row=row, status=status):
            row["status"] = "done"
            insert_after(row, "status", "curated",
                         f"2026-10-06 curation：终态归一 —— 原 status `{status}`（终态同义词），"
                         "渲染器只认 done/dropped，故归一以免计入「未关闭」。")

        changes.append((index, key, f"status {status} → done", apply))

    # ③ 逐 key 显式裁决
    for key, (new_status, note) in STATUS_FIXES_BY_KEY.items():
        target = last_of_key.get(key)
        if target is None or target[1].get("status") == new_status:
            continue
        index, row = target

        def apply(row=row, new_status=new_status, note=note):
            row["status"] = new_status
            insert_after(row, "status", "curated", note)

        changes.append((index, key, f"status {row.get('status')} → {new_status}", apply))

    # ④ 补缺失的 created/author
    for index, row in rows:
        key = row.get("key")
        if key not in MISSING_META_FIXES:
            continue
        created, author = MISSING_META_FIXES[key]
        if row.get("created") and row.get("author"):
            continue

        def apply(row=row, created=created, author=author):
            # 这两行缺字段 ⇒ 追加到末尾即可（不做重排，避免制造无谓 diff）
            row.setdefault("created", created)
            row.setdefault("author", author)

        changes.append((index, key, f"补 created={created} / author={author}", apply))

    changes.sort(key=lambda c: c[0])
    return changes


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--plan", action="store_true", help="干跑，只打印改动")
    group.add_argument("--apply", action="store_true", help="执行（先备份）")
    args = parser.parse_args()

    rows, bad = load()
    if bad:
        print(f"台账有坏行，先修：{bad}", file=sys.stderr)
        return 2

    changes = plan(rows)
    if not changes:
        print("无需改动（台账已是 curation 后的状态）。")
        return 0

    print(f"共 {len(changes)} 处改动（台账 {len(rows)} 行）：")
    for index, key, note, _ in changes:
        print(f"  L{index:<4} {key}\n          {note}")
    if args.plan:
        print("\n（干跑，未写入。加 --apply 执行。）")
        return 0

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = BACKUP_DIR / f"log.jsonl.{stamp}"
    shutil.copy2(LOG, backup)

    by_line = {}
    for index, row in rows:
        by_line[index] = row
    for index, _key, _note, apply in changes:
        apply()

    # 逐行重写，只改动的行会被重新序列化（其余行原文透传，避免无谓 diff）
    original_lines = LOG.read_text(encoding="utf-8").split("\n")
    touched = {index for index, _k, _n, _a in changes}
    out = []
    for number, line in enumerate(original_lines, 1):
        if number in touched and line.strip():
            out.append(json.dumps(by_line[number], ensure_ascii=False))
        else:
            out.append(line)
    LOG.write_text("\n".join(out), encoding="utf-8")
    print(f"\n已写入。备份：{backup.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
