#!/usr/bin/env bash
# macOS 双击启动器：检查环境、安装依赖、启动服务并打开浏览器。
set -e

cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

pause_on_error() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo
    echo "启动失败，请截图上面的错误信息。"
    read -r -p "按回车键关闭窗口…" _
  fi
  exit "$status"
}
trap pause_on_error EXIT

echo "========================================"
echo "  课件讲解平台 · 一键安装并启动"
echo "========================================"
echo

node_ok=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  if [ "$node_major" -ge 20 ]; then
    node_ok=1
  fi
fi

if [ "$node_ok" -ne 1 ]; then
  echo "未检测到 Node.js 20 或更高版本。"
  if command -v brew >/dev/null 2>&1; then
    echo "正在通过 Homebrew 安装 Node.js…"
    brew install node
    hash -r
  else
    echo "将打开 Node.js 官网，请安装 LTS 版后再双击本文件。"
    open "https://nodejs.org/zh-cn/download"
    read -r -p "按回车键关闭窗口…" _
    trap - EXIT
    exit 1
  fi
fi

echo "Node.js: $(node --version)"
echo "npm:     $(npm --version)"
echo

# start.sh 会在首次运行时安装 npm 依赖，随后启动服务并打开浏览器。
exec ./start.sh
