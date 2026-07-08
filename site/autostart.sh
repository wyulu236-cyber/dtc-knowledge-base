#!/usr/bin/env bash
# autostart.sh — launchd 入口,给开机自启用
# launchd 不会读 ~/.zshrc,所以这里手动把 ANTHROPIC_* 环境变量注入,
# 然后 exec 到原来的 start.sh(前台跑 python http.server + 后台 node answer-server)。
set -e

# 从 zshrc 里挑出 ANTHROPIC_ 相关 export,eval 注入当前 shell
if [ -f "$HOME/.zshrc" ]; then
  eval "$(grep -E '^[[:space:]]*export[[:space:]]+ANTHROPIC_' "$HOME/.zshrc" 2>/dev/null || true)"
fi

# 交给原来的 start.sh(不改动它,保留手动跑的兼容性)
exec "$HOME/dtc-knowledge-base/site/start.sh"
