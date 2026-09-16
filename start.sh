#!/usr/bin/env bash
# 一键启动课件讲解平台
#
#   ./start.sh              本机使用（用服务端自己的 Key，开箱即用）
#   ./start.sh --public     公开部署（访客自带 Key，数据按会话隔离）
set -e
cd "$(dirname "$0")"

PUBLIC=0
for arg in "$@"; do
  case "$arg" in
    --public|-p) PUBLIC=1 ;;
    --help|-h)
      echo "用法: ./start.sh [--public]"
      echo "  （无参数）   本机模式：用服务端自己的 API Key"
      echo "  --public     公开模式：访客必须自带 API Key，HOST 默认 0.0.0.0"
      exit 0
      ;;
  esac
done

if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖…"
  npm install --no-audit --no-fund
fi

PORT="${PORT:-4173}"

if [ "$PUBLIC" = "1" ]; then
  export PUBLIC_MODE=1
  export HOST="${HOST:-0.0.0.0}"
  echo "公开模式启动中… 监听 ${HOST}:${PORT}"
  echo "访客需要自己填写 API Key；数据按浏览器会话隔离。"
  exec node server/index.mjs
fi

export HOST="${HOST:-127.0.0.1}"
echo "启动中… 稍后会自动打开 http://127.0.0.1:${PORT}"

# macOS / Linux 自动打开浏览器
( sleep 1.2
  if command -v open >/dev/null 2>&1; then open "http://127.0.0.1:${PORT}"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:${PORT}"
  fi ) >/dev/null 2>&1 &

exec node server/index.mjs
