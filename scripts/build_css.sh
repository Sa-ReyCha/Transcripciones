#!/bin/sh
# Uso: scripts/build_css.sh [--watch]
cd "$(dirname "$0")/.." || exit 1
exec tailwindcss -i app/static/src/input.css -o app/static/tailwind.css --minify "$@"
