@echo off
setlocal EnableExtensions

cd /d "%~dp0"

if not defined PORT set "PORT=4317"
if not defined VITE_PORT set "VITE_PORT=5173"

call :kill_port_processes "%PORT%"
if errorlevel 1 exit /b %errorlevel%

call :kill_port_processes "%VITE_PORT%"
if errorlevel 1 exit /b %errorlevel%

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b %errorlevel%
)

call npm run dev
exit /b %errorlevel%

:kill_port_processes
set "TARGET_PORT=%~1"
set "FOUND_PID="

for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /R /C:":%TARGET_PORT% .*LISTENING"') do (
  set "FOUND_PID=1"
  echo Stopping process on port %TARGET_PORT%: %%P
  taskkill /PID %%P /T /F >nul 2>nul
)

exit /b 0
