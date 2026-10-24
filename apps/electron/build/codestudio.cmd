@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0CodeStudio.exe" "%~dp0resources\app.asar\dist\apps\cli\index.js" %*
exit /b %ERRORLEVEL%
