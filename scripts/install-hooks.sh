#!/usr/bin/env bash
# Включает хуки репозитория (.githooks) вместо .git/hooks: так хук лежит под версиями и приезжает
# вместе с кодом, а не остаётся на одной машине.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
chmod +x .githooks/*
git config core.hooksPath .githooks
echo "хуки включены: $(git config core.hooksPath)"
command -v gitleaks >/dev/null 2>&1 || echo "внимание: gitleaks не установлен — brew install gitleaks"
