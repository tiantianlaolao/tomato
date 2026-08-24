@echo off
set "PATH=%USERPROFILE%\.cargo\bin;C:\Program Files (x86)\Microsoft Visual Studio\Installer;%PATH%"
cd /d %~dp0..\src-tauri
cargo %*
