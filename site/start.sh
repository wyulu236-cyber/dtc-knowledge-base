#!/usr/bin/env bash
# site/start.sh — 一键启动本地预览 (双 server: 静态站 8080 + AI 答题 8081)
set -e

PORT="${PORT:-8080}"
ANSWER_PORT="${ANSWER_PORT:-8081}"
SITE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SITE_DIR/.." && pwd)"

echo "▶ Gracexiaoe · DTC Ads KB 本地预览"
echo "  网站      http://localhost:${PORT}/gracexiaoe/"
echo "  AI 答题   http://127.0.0.1:${ANSWER_PORT}/api/answer"
echo ""

# 检查 relay 配置
if [ -z "$ANTHROPIC_AUTH_TOKEN" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "⚠️  ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 都没设置 — AI 答题会启动失败,只跑静态站"
  echo "    在 ~/.zshrc 里 export 后重启 shell"
  echo ""
  ANSWER_DISABLED=1
fi

# 启动 answer-server (后台)
if [ -z "$ANSWER_DISABLED" ]; then
  ( cd "$ROOT_DIR" && exec node scripts/answer-server.js ) &
  ANSWER_PID=$!
  trap "echo ''; echo '▶ 停止 answer-server (PID $ANSWER_PID)'; kill $ANSWER_PID 2>/dev/null; exit 0" INT TERM
  sleep 1
fi

echo "(按 Ctrl+C 停止全部)"
echo ""

# 静态站 (前台)
exec python3 -m http.server "$PORT" --directory "$SITE_DIR"
