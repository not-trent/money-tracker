#!/usr/bin/env bash
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then
	python3 -m venv .venv
	source .venv/bin/activate
	python -m pip install -r requirements.txt
	exec python app.py
elif command -v uv >/dev/null 2>&1; then
	exec uv run --with-requirements requirements.txt --python 3.14 python app.py
else
	echo "Python 3.10+ or uv is required."
	exit 1
fi