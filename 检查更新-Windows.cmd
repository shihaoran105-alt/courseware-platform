@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 课件讲解平台 · 检查并安装更新
cd /d "%~dp0"

echo ========================================
echo   课件讲解平台 · 检查并安装更新
echo ========================================
echo.

if not exist "package.json" (
  echo [错误] 未找到 package.json。
  echo 请把本文件放在程序目录里再双击。
  goto :failed
)

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。
  echo 请先双击「一键安装并启动-Windows.cmd」完成环境安装。
  goto :failed
)

if not exist "node_modules\jszip" (
  echo 正在补齐更新程序所需依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :failed
)

node scripts\standalone-update.mjs
if errorlevel 1 goto :failed

echo.
echo 检查完成。如果发现更新，平台会自动重启。
timeout /t 3 >nul
exit /b 0

:failed
echo.
echo 更新失败，请截图上面的错误信息。
pause
exit /b 1
