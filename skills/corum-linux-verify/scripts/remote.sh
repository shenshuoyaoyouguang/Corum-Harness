#!/bin/bash
# corum-linux-verify: 统一远程入口（经用户系统代理 SSH 到 Linux 测试机）。
#
# 为什么长这样（每一条都是本仓付过学费的）：
#   · 沙箱内**无路由**（ARP 解析不出）⇒ 必须走用户系统代理 127.0.0.1:7890 的 SOCKS5。
#   · 沙箱内 `expect` 的 spawn 会报 "no more ptys" ⇒ 只能用 SSH_ASKPASS；
#     macOS 上也没有 `setsid`，故不依赖它。
#   · 密码**只从环境变量读**，任何情况下不落盘、不回显。
#
# 用法：
#   SSH_PW='...' remote.sh run   '<远程命令>'
#   SSH_PW='...' remote.sh script <本地脚本>              # 送过去用 bash 执行
#   SSH_PW='...' remote.sh push  <本地文件> <远程路径>     # 走 stdin（大小不限）
#   SSH_PW='...' remote.sh push-run <本地文件> <远程路径> '<远程命令>'
#
# 环境变量：
#   SSH_PW      必填，登录密码
#   DSH_HOST    目标主机（默认 root@192.168.1.18）
#   SSH_SOCKS   代理地址（默认 127.0.0.1:7890）
#
# push 走 `cat > <dst>`，数据经 **stdin**（密码走 ASKPASS，不占 stdin）。
# 曾经写成「base64 内联进命令行」，实测 **10 万字节就失败**
# （`Connection closed by remote host`，命令行过长）—— 小文件能过，大文件必炸。
# 几 MB 以上仍建议用 chunked-push.sh（长连接会 stall），但 stdin 这条形态
# 本身没有单条命令的长度上限。
set -uo pipefail

: "${SSH_PW:?需要 SSH_PW 环境变量（不要写进脚本）}"
HOST="${DSH_HOST:-root@192.168.1.18}"
PROXY="${SSH_SOCKS:-127.0.0.1:7890}"

# 密码应答器：只 printf 环境变量，不含凭据本身。
ASKPASS="$(mktemp -t corum-askpass.XXXXXX)"
# shellcheck disable=SC2064
trap "rm -f '$ASKPASS'" EXIT
printf '#!/bin/sh\nprintf "%%s\\n" "$SSH_PW"\n' > "$ASKPASS"
chmod 700 "$ASKPASS"

_ssh() {
  # $1 = 远程命令；stdin 透传（用于 push）
  SSH_PW="$SSH_PW" SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/tmp/corum_known_hosts \
      -o "ProxyCommand=nc -X 5 -x $PROXY %h %p" \
      -o ConnectTimeout=15 -o LogLevel=ERROR \
      -o PreferredAuthentications=password -o PubkeyAuthentication=no \
      -o NumberOfPasswordPrompts=1 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 \
      -T "$HOST" "$1"
}

mode="${1:?用法见脚本头}"; shift

case "$mode" in
  run)
    _ssh "${1:?需要远程命令}" </dev/null
    ;;
  script)
    src="${1:?需要本地脚本路径}"
    _ssh 'bash -s' < "$src"
    ;;
  push)
    src="${1:?需要本地文件}"; dst="${2:?需要远程路径}"
    [ -f "$src" ] || { echo "本地文件不存在：$src" >&2; exit 1; }
    _ssh "cat > '$dst'" < "$src"
    ;;
  push-run)
    src="${1:?}"; dst="${2:?}"; cmd="${3:?}"
    [ -f "$src" ] || { echo "本地文件不存在：$src" >&2; exit 1; }
    # 两段式：先落文件，再跑命令（同一条 SSH 里 stdin 只能给前者）。
    _ssh "cat > '$dst'" < "$src" || exit 1
    _ssh "$cmd" </dev/null
    ;;
  *)
    echo "未知模式：$mode（可用 run / script / push / push-run）" >&2
    exit 2
    ;;
esac
