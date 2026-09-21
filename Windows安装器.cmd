@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 课件讲解平台 · Windows 安装器

set "INSTALL_DIR=%LOCALAPPDATA%\Programs\课件讲解平台"
rem 自动找同目录下的完整包，不写死版本号 ——
rem 免得发版时忘了改这里，安装器去找一个根本不存在的文件名。
set "PAYLOAD="
for %%F in ("%~dp0courseware-platform-v*.zip") do set "PAYLOAD=%%~fF"
set "WORK_DIR=%TEMP%\courseware-installer-%RANDOM%-%RANDOM%"
set "SOURCE_DIR=%WORK_DIR%\courseware-platform"

echo ========================================
echo   课件讲解平台 · Windows 一键安装
echo ========================================
echo.

if not defined PAYLOAD (
  echo [错误] 安装包不完整：同目录下找不到 courseware-platform-v*.zip
  echo 请确认已经把整个压缩包完整解压，并且没有单独移动安装器。
  goto :failed
)

echo 正在解压并检查完整程序包...
if exist "%WORK_DIR%" rmdir /s /q "%WORK_DIR%"
mkdir "%WORK_DIR%" >nul 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Expand-Archive -LiteralPath $env:PAYLOAD -DestinationPath $env:WORK_DIR -Force"
if errorlevel 1 goto :failed

if not exist "%SOURCE_DIR%\package.json" (
  echo [错误] 安装包结构不正确：缺少 package.json
  goto :failed
)
if not exist "%SOURCE_DIR%\server\index.mjs" (
  echo [错误] 安装包不完整：缺少 server\index.mjs
  goto :failed
)
if not exist "%SOURCE_DIR%\server\stages.mjs" (
  echo [错误] 安装包不完整：缺少 server\stages.mjs
  goto :failed
)

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%" >nul 2>nul
if not exist "%INSTALL_DIR%" (
  echo [错误] 无法创建安装目录：%INSTALL_DIR%
  goto :failed
)

echo 正在删除旧程序并保留用户数据...
for /d %%D in ("%INSTALL_DIR%\*") do (
  if /I not "%%~nxD"=="data" rmdir /s /q "%%~fD"
)
for %%F in ("%INSTALL_DIR%\*") do (
  if exist "%%~fF" if /I not "%%~nxF"==".env" del /f /q "%%~fF"
)

echo 正在安装到：%INSTALL_DIR%
xcopy "%SOURCE_DIR%\*" "%INSTALL_DIR%\" /E /I /H /Y >nul
if errorlevel 1 goto :failed

if not exist "%INSTALL_DIR%\server\stages.mjs" (
  echo [错误] 安装后校验失败：server\stages.mjs 未正确写入
  goto :failed
)
if not exist "%INSTALL_DIR%\一键安装并启动-Windows.cmd" (
  echo [错误] 安装后校验失败：缺少启动脚本
  goto :failed
)

call :create_desktop_launcher
if errorlevel 1 (
  echo [提示] 桌面启动器创建失败，但程序已经安装完成。
) else (
  echo 已在桌面创建「启动课件讲解平台」。
)

if exist "%WORK_DIR%" rmdir /s /q "%WORK_DIR%"
echo.
echo 安装完成，正在启动...
call "%INSTALL_DIR%\一键安装并启动-Windows.cmd"
exit /b %errorlevel%

rem ---------------------------------------------------------------
rem 桌面快捷方式。
rem 注意：**不能**用 echo 重定向去写这个 .cmd —— 那样写出来的是不带 BOM 的
rem UTF-8，下次双击时 cmd 会用系统代码页（中文系统 GBK）去读，中文全乱。
rem 所以交给 PowerShell 用 UTF8Encoding($true) 写，明确带上 BOM。
rem ---------------------------------------------------------------
:create_desktop_launcher
set "DESKTOP_DIR="
for /f "usebackq delims=" %%D in (`powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP_DIR=%%D"
if not defined DESKTOP_DIR exit /b 1
if not exist "%DESKTOP_DIR%" exit /b 1
set "DESKTOP_LAUNCHER=%DESKTOP_DIR%\启动课件讲解平台.cmd"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$lines = @('@echo off','chcp 65001 >nul','cd /d \"%INSTALL_DIR%\"','call \"一键安装并启动-Windows.cmd\"');" ^
  "[IO.File]::WriteAllText($env:DESKTOP_LAUNCHER, ($lines -join [Environment]::NewLine) + [Environment]::NewLine, (New-Object Text.UTF8Encoding $true))"
if errorlevel 1 exit /b 1
exit /b 0

:failed
if exist "%WORK_DIR%" rmdir /s /q "%WORK_DIR%"
echo.
echo 安装未完成，请截图上面的错误信息。
pause
exit /b 1
