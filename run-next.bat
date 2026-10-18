@echo off
REM crashgraph with the Next.js console.
REM   FalkorDB          :6379   (FalkorDB Browser also takes :3000, which is why Next is on 3001)
REM   FastAPI           :8000   trainer, graph, websocket
REM   Next.js console   :3001   the UI
REM The browser talks to Next; Next proxies /api to FastAPI, and the websocket connects straight
REM to :8000 because Next rewrites do not carry websocket upgrades.
REM
REM Note: this file uses goto labels rather than nested if-blocks. In batch, %VAR% inside a
REM parenthesised block is expanded when the block is parsed, not when it runs, so a variable
REM set and used in the same block comes out empty.
cd /d %~dp0

REM --- is a database already configured? ---------------------------------
if defined FALKORDB_URL goto :python
if not exist .env goto :finddocker
findstr /b /c:"FALKORDB_URL=" .env >nul 2>nul && goto :python

REM --- otherwise start FalkorDB in Docker --------------------------------
:finddocker
set "DOCKER="
for %%I in (docker.exe) do if not defined DOCKER set "DOCKER=%%~$PATH:I"
if not defined DOCKER if exist "%ProgramFiles%\Docker\Docker\resources\bin\docker.exe" set "DOCKER=%ProgramFiles%\Docker\Docker\resources\bin\docker.exe"
if not defined DOCKER goto :nodb

"%DOCKER%" compose up -d
if errorlevel 1 goto :dockerfailed
echo [db] FalkorDB on localhost:6379  (FalkorDB Browser: http://localhost:3000)
set "FALKORDB_URL=redis://localhost:6379"
goto :python

:dockerfailed
echo.
echo   docker compose failed. If Docker Desktop has just started, its Linux engine may still
echo   be warming up - wait a few seconds and run this again.
echo.
pause
exit /b 1

:nodb
echo.
echo   No FalkorDB to connect to. Either:
echo     A^) install Docker Desktop from https://www.docker.com/products/docker-desktop
echo     B^) add FALKORDB_URL=redis://user:pass@host:port to .env ^(FalkorDB Cloud^)
echo.
pause
exit /b 1

REM --- Python backend ----------------------------------------------------
:python
if exist .venv\Scripts\python.exe goto :haspy
echo [setup] creating .venv
python -m venv .venv
if errorlevel 1 goto :nopython
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto :pipfailed

:haspy
start "crashgraph api" .venv\Scripts\python.exe server.py
goto :node

:nopython
echo Install Python 3.12+ from python.org, then run this again.
pause
exit /b 1

:pipfailed
echo pip install failed.
pause
exit /b 1

REM --- Next.js console ---------------------------------------------------
:node
where node >nul 2>nul
if errorlevel 1 goto :nonode
cd web-next
if exist node_modules goto :built
echo [setup] installing the console's packages, this takes a minute
call npm install --no-audit --no-fund
if errorlevel 1 goto :npmfailed

:built
if exist .next goto :serve
call npm run build
if errorlevel 1 goto :npmfailed

:serve
start "" http://localhost:3001
call npm start
exit /b 0

:nonode
echo Install Node 18+ from nodejs.org, then run this again.
pause
exit /b 1

:npmfailed
echo The console failed to install or build. Scroll up for the reason.
pause
exit /b 1
