#!/usr/bin/env sh
# TMS 배송코스 최적화 — 개발 서버 실행 (macOS / Linux)
# 더블클릭하거나 터미널에서 ./start.sh 로 실행하세요.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js 가 설치되어 있지 않습니다."
  echo "  https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요."
  echo ""
  printf "  엔터를 누르면 닫힙니다..."
  read -r _
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo ""
  echo "  Node.js 18 이상이 필요합니다 (현재 $(node -v))."
  echo "  https://nodejs.org 에서 LTS 버전으로 업데이트하세요."
  echo ""
  printf "  엔터를 누르면 닫힙니다..."
  read -r _
  exit 1
fi

exec node tools/dev-server.mjs
