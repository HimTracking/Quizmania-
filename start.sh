#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required. Install it from https://nodejs.org/ and try again."
  exit 1
fi
if [ ! -f .env ]; then cp .env.example .env; fi
if [ ! -d node_modules ]; then npm install; fi
echo "QuizArena: http://localhost:3000"
echo "Host Studio: http://localhost:3000/admin"
npm start
