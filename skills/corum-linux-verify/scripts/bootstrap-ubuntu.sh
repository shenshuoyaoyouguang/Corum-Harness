#!/bin/bash
# corum-linux-verify: 目标机幂等引导（apt 依赖 / Node / pnpm / .npmrc / 自检）。
#
# 在**目标机**上执行（经 remote.sh script 送入）。重复执行安全。
#
# 用法：SSH_PW='...' remote.sh script bootstrap-ubuntu.sh
#   REPO=/opt/corum/Corum-Harness        # 仓库落地路径（默认）
#   NODE_VER=v22.20.0                    # 须满足 engines ^22.19.0 || >=24
#   PNPM_VER=11.7.0                      # 须与 package.json packageManager 一致
#   DSH_REGISTRY=http://192.168.1.4:4873/  # Mac 上的 verdaccio（dsh-tools 只在私服）
set -uo pipefail

REPO="${REPO:-/opt/corum/Corum-Harness}"
NODE_VER="${NODE_VER:-v22.20.0}"
PNPM_VER="${PNPM_VER:-11.7.0}"
DSH_REGISTRY="${DSH_REGISTRY:-http://192.168.1.4:4873/}"

say() { printf '\n=== %s ===\n' "$*"; }

say "1. apt 依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# bubblewrap：Agent 沙箱首选档，缺它 fail-closed（每次 bash 都失败）
# libfuse2t64：AppImage 运行依赖，Ubuntu 24.04 默认不带
# fuse3/xvfb/x11-utils/xauth/imagemagick/xdotool：无头运行 + 真实像素/输入验证
apt-get install -y -qq git curl rsync ca-certificates \
  bubblewrap libfuse2t64 fuse3 xvfb x11-utils xauth imagemagick xdotool
echo "apt exit=$?"

say "2. Node $NODE_VER"
NODE_ROOT="/usr/local/node-$NODE_VER-linux-x64"
if [ ! -d "$NODE_ROOT" ]; then
  curl -fsSL --max-time 600 -o /tmp/node.tar.xz \
    "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" || exit 1
  tar -xJf /tmp/node.tar.xz -C /usr/local && rm -f /tmp/node.tar.xz
fi
# 关键：逐个 ln 到 /usr/local/bin。npm i -g 把 pnpm 装进 node 自己的 prefix，
# 不加这些链接的话非交互 SSH 里 `pnpm` 找不到。
for t in node npm npx pnpm pnpx corepack; do
  [ -e "$NODE_ROOT/bin/$t" ] && ln -sfn "$NODE_ROOT/bin/$t" "/usr/local/bin/$t"
done
printf 'export PATH="%s/bin:$PATH"\n' "$NODE_ROOT" > /etc/profile.d/corum-node.sh
echo "  node=$(node -v 2>/dev/null)  npm=$(npm -v 2>/dev/null)"

say "3. pnpm $PNPM_VER"
if [ "$(pnpm -v 2>/dev/null)" != "$PNPM_VER" ]; then
  npm i -g "pnpm@$PNPM_VER" >/dev/null 2>&1
  ln -sfn "$NODE_ROOT/bin/pnpm" /usr/local/bin/pnpm
fi
echo "  pnpm=$(pnpm -v 2>/dev/null)"

say "4. .npmrc（@deepseek-ai 指向 Mac 私服）"
if [ -d "$REPO" ]; then
  cat > "$REPO/.npmrc" <<EOF
# 由 corum-linux-verify 引导生成：@deepseek-ai 走 Mac 上的 verdaccio。
# 起因：@deepseek-ai/dsh-tools@0.1.3-alpha.1 只发布到该私服（公共 npm 只有 -alpha.2），
# 而 lockfile 钉死该版本 ⇒ 公共 registry 必然 404。
@deepseek-ai:registry=$DSH_REGISTRY
registry=https://registry.npmjs.org/
strict-ssl=false
EOF
  echo "  已写 $REPO/.npmrc"
else
  echo "  ⚠️ 仓库目录不存在：$REPO（先 clone 再回来跑本步）"
fi

say "5. 自检"
for t in git node npm pnpm bwrap curl rsync python3 zenity; do
  printf '  %-9s ' "$t"; command -v "$t" >/dev/null 2>&1 && command -v "$t" || echo '(缺)'
done
printf '  %-9s ' 'libfuse'; ldconfig -p 2>/dev/null | grep -q libfuse && echo OK || echo '(缺 → AppImage 起不来)'
[ -x /usr/bin/bwrap ] && { bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc \
  --die-with-parent /usr/bin/true >/dev/null 2>&1 && echo '  bwrap 探针 OK' || echo '  ⚠️ bwrap 装了但 profile 起不来'; }

if [ -d "$REPO/packages/desktop" ]; then
  say "6. 产物平台判据（必须是本机平台的二进制）"
  B="$REPO/packages/desktop/build/node/bin/node"
  [ -f "$B" ] && file -b "$B" | cut -c1-70 || echo "  build/node 未物化（先跑 pack:node）"
fi
echo
echo "引导完成。"
