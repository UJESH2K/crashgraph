@echo off
REM crashgraph on Windows: FalkorDB in Docker, Python app on the host.
cd /d %~dp0
where docker >nul 2>nul || (echo Install Docker Desktop first: https://www.docker.com/products/docker-desktop & exit /b 1)
docker compose up -d
if not exist .venv (
  python -m venv .venv
  call .venv\Scripts\activate
  pip install -r requirements.txt
) else (
  call .venv\Scripts\activate
)
set FALKORDB_URL=redis://localhost:6379
start "" http://localhost:8000
python server.py
