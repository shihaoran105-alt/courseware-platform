@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 课件讲解平台 · 一键安装并启动
cd /d "%~dp0"

echo ========================================
echo   课件讲解平台 · Windows 一键安装并启动
echo ========================================
echo.

if not exist "package.json" (
  echo [错误] 未找到 package.json。
  echo 请把本文件放在项目根目录后再双击。
  goto :failed
)

call :check_node
if errorlevel 1 goto :install_node
goto :node_ready

:install_node
echo 未检测到 Node.js 20 或更高版本。
where winget >nul 2>nul
if errorlevel 1 goto :manual_node

echo 正在自动安装 Node.js LTS，请稍候...
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto :manual_node

rem 刷新当前窗口可用的常见 Node.js 路径。
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
call :check_node
if errorlevel 1 (
  echo Node.js 已安装，但当前窗口尚未识别。
  echo 请关闭本窗口，然后再次双击本文件。
  goto :failed
)
goto :node_ready

:manual_node
echo.
echo 无法自动安装 Node.js。即将打开官网，请安装 LTS 版后再次双击本文件。
start "" "https://nodejs.org/zh-cn/download"
goto :failed

:node_ready
echo Node.js:
node --version
echo npm:
call npm --version
if errorlevel 1 goto :failed
echo.

if not exist "node_modules" (
  echo 首次运行，正在安装项目依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :failed
  echo.
)

call :create_desktop_launcher
if errorlevel 1 (
  echo [提示] 桌面启动器创建失败，但不影响平台启动。
) else (
  echo 已在桌面创建「启动课件讲解平台.cmd」。
)
echo.

echo 正在启动平台...
echo 网址：http://127.0.0.1:4173
echo 请保持本窗口打开；按 Ctrl+C 可停止服务。
echo.

start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:4173'"
set "HOST=127.0.0.1"
if not defined PORT set "PORT=4173"
node server\index.mjs
if errorlevel 1 goto :failed
exit /b 0

:check_node
set "NODE_MAJOR="
where node >nul 2>nul
if errorlevel 1 exit /b 1
for /f "usebackq delims=" %%V in (`node -p "Number(process.versions.node.split('.')[0])" 2^>nul`) do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR exit /b 1
if %NODE_MAJOR% LSS 20 exit /b 1
exit /b 0

:create_desktop_launcher
set "DESKTOP_DIR="
for /f "usebackq delims=" %%D in (`powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP_DIR=%%D"
if not defined DESKTOP_DIR exit /b 1
if not exist "%DESKTOP_DIR%" exit /b 1
set "DESKTOP_LAUNCHER=%DESKTOP_DIR%\启动课件讲解平台.cmd"
>"%DESKTOP_LAUNCHER%" echo @echo off
>>"%DESKTOP_LAUNCHER%" echo chcp 65001 ^>nul
>>"%DESKTOP_LAUNCHER%" echo cd /d "%CD%"
>>"%DESKTOP_LAUNCHER%" echo call "一键安装并启动-Windows.cmd"
exit /b 0

:failed
echo.
echo 安装或启动未完成，请截图上面的错误信息。
pause
exit /b 1
