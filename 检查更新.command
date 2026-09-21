#!/usr/bin/env bash
# macOS 双击运行：下载、校验并安装 GitHub 最新完整包。
set -e

cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
chmod +x "$0" ./start.sh ./一键安装并启动.command 2>/dev/null || true

pause_on_error() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo
    echo "更新失败，请截图上面的错误信息。"
    read -r -p "按回车键关闭窗口…" _
  fi
  exit "$status"
}
trap pause_on_error EXIT

echo "========================================"
echo "  课件讲解平台 · 检查并安装更新"
echo "========================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先双击「一键安装并启动.command」完成环境安装。"
  exit 1
fi

if [ ! -d node_modules/jszip ]; then
  echo "正在补齐更新程序所需依赖…"
  npm install --no-audit --no-fund
fi

node scripts/standalone-update.mjs
trap - EXIT
echo
echo "检查完成。如果发现更新，平台会自动重启。"
sleep 2
