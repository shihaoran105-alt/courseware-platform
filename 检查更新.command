#!/usr/bin/env bash
# macOS 双击运行：检查本机课件讲解平台是否为 GitHub 最新版本。
set -u

cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

VERSION_URL="https://raw.githubusercontent.com/shihaoran105-alt/courseware-platform/main/version.json"
REPO_URL="https://github.com/shihaoran105-alt/courseware-platform"
TMP_FILE="$(mktemp -t courseware-version.XXXXXX)"
trap 'rm -f "$TMP_FILE"' EXIT

pause() {
  echo
  read -r -p "按回车键关闭窗口…" _
}

json_version() {
  file="$1"
  if command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs"); try { const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (!/^\d+\.\d+\.\d+$/.test(String(x.version||""))) process.exit(1); process.stdout.write(String(x.version)); } catch { process.exit(1); }' "$file"
  else
    sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' "$file" | head -n 1
  fi
}

version_gt() {
  left="$1"
  right="$2"
  old_ifs="$IFS"
  IFS=.
  set -- $left
  a1=${1:-0}; a2=${2:-0}; a3=${3:-0}
  set -- $right
  b1=${1:-0}; b2=${2:-0}; b3=${3:-0}
  IFS="$old_ifs"
  [ "$a1" -gt "$b1" ] || { [ "$a1" -eq "$b1" ] && { [ "$a2" -gt "$b2" ] || { [ "$a2" -eq "$b2" ] && [ "$a3" -gt "$b3" ]; }; }; }
}

echo "========================================"
echo "  课件讲解平台 · 检查更新"
echo "========================================"
echo

if [ ! -f "version.json" ]; then
  echo "找不到 version.json。"
  echo "请把“检查更新.command”放在课件讲解平台的项目根目录后再运行。"
  pause
  exit 1
fi

local_version="$(json_version "version.json")"
if [ -z "$local_version" ]; then
  echo "无法读取本机版本号，version.json 可能已损坏。"
  pause
  exit 1
fi

echo "本机版本：v$local_version"
echo "正在查询 GitHub 最新版本…"

if ! curl -fsSL --connect-timeout 8 --max-time 20 -H 'Cache-Control: no-cache' "${VERSION_URL}?t=$(date +%s)" -o "$TMP_FILE"; then
  echo
  echo "检查失败：无法连接 GitHub。请确认网络正常后再试。"
  pause
  exit 1
fi

remote_version="$(json_version "$TMP_FILE")"
if [ -z "$remote_version" ]; then
  echo
  echo "检查失败：GitHub 返回的版本信息无法识别。"
  pause
  exit 1
fi

echo "最新版本：v$remote_version"
echo

if [ "$local_version" = "$remote_version" ]; then
  echo "✓ 已经是最新版本，不需要更新。"
elif version_gt "$remote_version" "$local_version"; then
  echo "发现新版本：v$local_version → v$remote_version"
  echo
  echo "更新方法：打开 GitHub，点击 Code → Download ZIP，"
  echo "解压后使用新文件夹。旧项目里的 data 文件夹请保留，它包含本机数据和设置。"
  echo
  read -r -p "现在打开 GitHub 下载页面？[Y/n] " answer
  case "${answer:-Y}" in
    n|N) ;;
    *) open "$REPO_URL" ;;
  esac
else
  echo "本机版本比 GitHub 上的版本更新，无需下载。"
fi

pause
