#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")"

API_PORT="${PORT:-4317}"
WEB_PORT="${VITE_PORT:-5173}"

kill_port_processes() {
  local port="$1"
  local pids

  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return
  fi

  echo "Stopping process on port $port: $pids"
  kill $pids 2>/dev/null || true
  sleep 1

  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "Force stopping process on port $port: $pids"
    kill -9 $pids 2>/dev/null || true
  fi
}

kill_port_processes "$API_PORT"
kill_port_processes "$WEB_PORT"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

export PORT="$API_PORT"
export VITE_PORT="$WEB_PORT"

npm run dev
