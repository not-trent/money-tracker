@echo off
cd /d "%~dp0"
set "PY_CMD="
where py >nul 2>nul
if not errorlevel 1 set "PY_CMD=py"
if not defined PY_CMD (
  python --version >nul 2>nul
  if not errorlevel 1 set "PY_CMD=python"
)
if not defined PY_CMD (
  where uv >nul 2>nul
  if not errorlevel 1 (
    uv run --with-requirements requirements.txt --python 3.14 python app.py
    if errorlevel 1 exit /b 1
    exit /b 0
  )
)
if not defined PY_CMD (
  echo Python 3.10 or newer is required. Install Python and try again.
  pause
  exit /b 1
)
%PY_CMD% -m venv .venv
if errorlevel 1 exit /b 1
call .venv\Scripts\activate.bat
python -m pip install -r requirements.txt
if errorlevel 1 exit /b 1
python app.py