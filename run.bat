@echo off
REM crashgraph on Windows. Three ways to get FalkorDB, tried in this order:
REM   1. FALKORDB_URL / FALKORDB_CLOUD_URL already set in .env or the environment (FalkorDB Cloud)
REM   2. Docker Desktop, via docker-compose.yml (loads the trained memory from data/)
REM   3. nothing -> print the options and stop
cd /d %~dp0
setlocal enabledelayedexpansion

REM --- Python venv -------------------------------------------------------
if not exist .venv\Scripts\python.exe (
  echo [setup] creating .venv
  python -m venv .venv || (echo Install Python 3.12+ from python.org, then run this again. & pause & exit /b 1)
  .venv\Scripts\python.exe -m pip install --upgrade pip
  .venv\Scripts\python.exe -m pip install -r requirements.txt || (echo [setup] pip install failed & pause & exit /b 1)
)

REM --- Is a FalkorDB URL already configured? ----------------------------
REM Only FALKORDB_URL names the database the app runs against. FALKORDB_CLOUD_URL is just a
REM push target for push_to_cloud.py, so it must NOT stop us from starting the local Docker one.
set HAVE_URL=
if defined FALKORDB_URL set HAVE_URL=1
if not defined HAVE_URL (
  if exist .env findstr /b /c:"FALKORDB_URL=" .env >nul 2>nul && set HAVE_URL=1
)

if defined HAVE_URL (
  echo [db] using the FalkorDB URL from the environment / .env
  goto :serve
)

REM --- Otherwise try Docker ---------------------------------------------
REM Docker Desktop only adds itself to PATH for shells opened after it was installed, so fall
REM back to the default install path before deciding it is missing.
set DOCKER=
where docker >nul 2>nul && set DOCKER=docker
if not defined DOCKER (
  if exist "%ProgramFiles%\Docker\Docker\resources\bin\docker.exe" set DOCKER="%ProgramFiles%\Docker\Docker\resources\bin\docker.exe"
)
if not defined DOCKER goto :nodb

%DOCKER% compose up -d
if errorlevel 1 (
  echo [db] docker compose failed. If Docker Desktop has just started, its Linux engine may
  echo      still be warming up - wait a few seconds and run this again.
  goto :nodb
)
echo [db] FalkorDB in Docker on localhost:6379 ^(browser: http://localhost:3000^)
set FALKORDB_URL=redis://localhost:6379
goto :serve

:nodb
echo.
echo   No FalkorDB to connect to. Pick one:
echo.
echo   A^) FalkorDB Cloud ^(no install^): make a free instance at https://app.falkordb.cloud
echo      then add one line to .env  ^(encode # as %%23, @ as %%40 in the password^):
echo        FALKORDB_URL=redis://falkordb:YOUR_PASSWORD@HOST:PORT
echo      and run push_to_cloud.py once to upload the trained memory.
echo.
echo   B^) Docker Desktop: install from https://www.docker.com/products/docker-desktop
echo      start it, then run this script again. The trained memory in data\ loads automatically.
echo.
pause
exit /b 1

:serve
start "" http://localhost:8000
.venv\Scripts\python.exe server.py
