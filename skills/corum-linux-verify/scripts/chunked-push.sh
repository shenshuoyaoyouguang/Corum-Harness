#!/bin/bash
# corum-linux-verify: 分块传输（>几 MB 必用）。
#
# 为什么不能一次性传（实测）：同一链路 10 MB 单独传 1.4 s（≈7.7 MB/s），
# 而一条 SSH 里 `cat` 传 52 MB **卡在 21 MB / 10 分钟**。长连接会 stall。
# ⇒ 拆成小块、每块独立一条 SSH、逐块 SHA256、失败重试，收尾再校验全文件。
#
# 用法：SSH_PW='...' chunked-push.sh <本地文件> <远程路径> [块大小，默认 4m]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="$HERE/remote.sh"
: "${SSH_PW:?需要 SSH_PW 环境变量}"
src="${1:?需要本地文件}"; dst="${2:?需要远程路径}"; chunk="${3:-4m}"
[ -f "$src" ] || { echo "本地文件不存在：$src" >&2; exit 1; }

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
rm -f "$work"/part-*
split -b "$chunk" -d -a 3 "$src" "$work/part-"
total=$(ls "$work"/part-* | wc -l | tr -d ' ')
echo "[chunked-push] $(basename "$src") → $dst  共 $total 块（$(ls -lh "$src" | awk '{print $5}')）"

"$REMOTE" run "rm -f '$dst'.part-*" >/dev/null 2>&1

i=0
for f in "$work"/part-*; do
  i=$((i + 1)); idx=$(printf '%03d' $((i - 1)))
  want=$(shasum -a 256 "$f" | awk '{print $1}')
  ok=0
  for attempt in 1 2 3 4 5; do
    "$REMOTE" push "$f" "$dst.part-$idx" >/dev/null 2>&1
    got=$("$REMOTE" run "sha256sum '$dst.part-$idx' 2>/dev/null | cut -d' ' -f1" 2>/dev/null | tr -d '\r\n' | tail -c 64)
    [ "$want" = "$got" ] && { ok=1; break; }
    echo "[chunked-push]   $idx 第 $attempt 次校验不符，重试"
    sleep 2
  done
  [ "$ok" = 1 ] || { echo "[chunked-push] $idx 最终失败" >&2; exit 1; }
  echo "[chunked-push] $i/$total $idx OK"
done

echo "[chunked-push] 合并中…"
"$REMOTE" run "cat '$dst'.part-* > '$dst' && rm -f '$dst'.part-* && ls -l '$dst'" | tail -1

want=$(shasum -a 256 "$src" | awk '{print $1}')
got=$("$REMOTE" run "sha256sum '$dst' | cut -d' ' -f1" 2>/dev/null | tr -d '\r\n' | tail -c 64)
if [ "$want" = "$got" ]; then echo "[chunked-push] ✅ 全文件校验通过"; exit 0; fi
echo "[chunked-push] ❌ 全文件校验失败：local=$want remote=$got" >&2; exit 1
