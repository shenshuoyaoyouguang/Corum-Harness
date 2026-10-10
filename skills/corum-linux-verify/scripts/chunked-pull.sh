#!/bin/bash
# corum-linux-verify: 从远端分块拉取（chunked-push 的反向；长连接会 stall）
# 用法：SSH_PW='..' chunked-pull.sh <远程文件> <本地路径> [块大小]
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="$HERE/remote.sh"
: "${SSH_PW:?需要 SSH_PW 环境变量}"
remote_file="${1:?需要远程文件}"; local_path="${2:?需要本地路径}"; chunk="${3:-4m}"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

echo "[chunked-pull] 远端分块中…"
"$REMOTE" run "rm -rf ${remote_file}.cpart-*; split -b $chunk -d -a 3 '$remote_file' '${remote_file}.cpart-' && ls ${remote_file}.cpart-* | wc -l" 2>&1 | tail -1 > "$tmp/count"
total=$(tr -d '\r\n' < "$tmp/count")
echo "[chunked-pull] 共 $total 块"

mkdir -p "$(dirname "$local_path")"
i=0
for idx in $(seq -w 0 $((total - 1))); do
  i=$((i + 1)); part="${remote_file}.cpart-$(printf '%03d' $((10#$idx)))"
  out="$tmp/part-$idx"
  ok=0
  for attempt in 1 2 3 4 5; do
    if "$REMOTE" run "cat '$part'" > "$out" 2>/dev/null; then
      want=$("$REMOTE" run "sha256sum '$part' | cut -d' ' -f1" 2>/dev/null | tr -d '\r\n' | tail -c 64)
      got=$(shasum -a 256 "$out" | awk '{print $1}')
      [ "$want" = "$got" ] && { ok=1; break; }
    fi
    echo "[chunked-pull]   $idx 第 $attempt 次校验不符，重试"; sleep 2
  done
  [ "$ok" = 1 ] || { echo "[chunked-pull] $idx 失败" >&2; exit 1; }
  echo "[chunked-pull] $i/$total $idx OK"
done

cat "$tmp"/part-* > "$local_path"
"$REMOTE" run "rm -f ${remote_file}.cpart-*" >/dev/null 2>&1

want=$("$REMOTE" run "sha256sum '$remote_file' | cut -d' ' -f1" 2>/dev/null | tr -d '\r\n' | tail -c 64)
got=$(shasum -a 256 "$local_path" | awk '{print $1}')
if [ "$want" = "$got" ]; then echo "[chunked-pull] ✅ 全文件校验通过（$(ls -lh "$local_path" | awk '{print $5}')）"; exit 0; fi
echo "[chunked-pull] ❌ 全文件校验失败" >&2; exit 1
