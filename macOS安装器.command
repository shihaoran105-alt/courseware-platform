#!/usr/bin/env bash
# 课件讲解平台 macOS DMG 安装器。
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
installer_dir="$(cd "$(dirname "$0")" && pwd -P)"
payload_zip="${installer_dir}/courseware-platform-v1.4.2.zip"
install_root="${HOME}/Applications"
install_dir="${install_root}/课件讲解平台"

work_dir=""

cleanup() {
  if [ -n "$work_dir" ] && [ -d "$work_dir" ]; then
    rm -rf "$work_dir"
  fi
}

finish() {
  status=$?
  cleanup
  if [ "$status" -ne 0 ]; then
    echo
    echo "安装失败，请截图上面的错误信息。"
    read -r -p "按回车键关闭窗口…" _
  fi
  exit "$status"
}
trap finish EXIT

echo "========================================"
echo "  课件讲解平台 · macOS 安装器"
echo "========================================"
echo

if [ ! -f "$payload_zip" ]; then
  echo "安装包不完整：缺少 $(basename "$payload_zip")"
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/courseware-installer.XXXXXX")"

echo "正在解压新版本…"
ditto -x -k "$payload_zip" "$work_dir"
source_dir="${work_dir}/courseware-platform"
if [ ! -f "${source_dir}/package.json" ]; then
  echo "安装包结构不正确。"
  exit 1
fi
if [ ! -f "${source_dir}/server/index.mjs" ]; then
  echo "安装包不完整：缺少 server/index.mjs"
  exit 1
fi
if [ ! -f "${source_dir}/server/stages.mjs" ]; then
  echo "安装包不完整：缺少 server/stages.mjs"
  exit 1
fi

mkdir -p "$install_root" "$install_dir"

# 更新时清理旧程序，但保留用户课件、记录和本机配置。
find "$install_dir" -mindepth 1 -maxdepth 1 \
  ! -name data \
  ! -name .env \
  -exec rm -rf {} +

echo "正在安装到：$install_dir"
ditto "$source_dir" "$install_dir"
chmod +x \
  "$install_dir/start.sh" \
  "$install_dir/一键安装并启动.command" \
  "$install_dir/检查更新.command" 2>/dev/null || true

if [ ! -f "${install_dir}/server/stages.mjs" ]; then
  echo "安装后校验失败：server/stages.mjs 未正确写入"
  exit 1
fi

echo
echo "安装完成，正在启动…"
trap - EXIT
cleanup
open -a Terminal "$install_dir/一键安装并启动.command"
exit 0
