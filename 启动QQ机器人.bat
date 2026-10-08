@echo off
rem QQ Agent launcher (desktop app, no npm window)
rem NOTE: keep this file ASCII-only. cmd parses .bat in GBK on Chinese
rem Windows; UTF-8 Chinese comments swallow the newline and break parsing.
rem 2026-09-23: check electron.exe exists; a missing exe would otherwise
rem make the double-click look completely dead with zero feedback.
rem 2026-10-04: if the parent shell exported ELECTRON_RUN_AS_NODE (some
rem Electron-based terminals do), electron.exe would run as plain node and
rem the app would never open. Clear it so double-click always launches the GUI.
set ELECTRON_RUN_AS_NODE=
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [QQ Agent] electron.exe not found under node_modules\electron\dist\
  echo [QQ Agent] fix: run npm install first
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
