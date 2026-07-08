#!/usr/bin/env bash
# scripts/02_download_subtitles.sh
# 对 meta/<slug>/index.json 里每个视频抓 EN 字幕(优先 manual,fallback auto-generated)
# 输出: raw/<slug>/<video_id>.en.vtt
#
# 用法: ./scripts/02_download_subtitles.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
META="$ROOT/meta"
RAW="$ROOT/raw"

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "❌ yt-dlp 未安装。" >&2; exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq 未安装。" >&2; exit 1
fi

mkdir -p "$RAW"
total=0; got=0; skip=0

for index in "$META"/*/index.json; do
  slug=$(basename "$(dirname "$index")")
  mkdir -p "$RAW/$slug"
  skipped_log="$META/$slug/skipped.json"
  : > "$skipped_log.tmp"

  echo "▶ [$slug]"
  while IFS= read -r row; do
    vid=$(echo "$row" | jq -r '.id')
    url=$(echo "$row" | jq -r '.url')
    total=$((total+1))

    target="$RAW/$slug/$vid.en.vtt"
    if [[ -s "$target" ]]; then
      echo "  · $vid 已存在,跳过"; got=$((got+1)); continue
    fi

    # --write-subs 拉 manual,--write-auto-subs fallback auto-gen,
    # --skip-download 不下视频,--sub-format vtt 统一格式
    if yt-dlp --write-subs --write-auto-subs --sub-lang en \
              --skip-download --sub-format vtt \
              --no-warnings --quiet \
              -o "$RAW/$slug/%(id)s.%(ext)s" \
              "$url" 2>/dev/null; then
      # yt-dlp 输出可能是 <id>.en.vtt 也可能 <id>.en-en.vtt 等,统一 rename
      latest=$(ls -t "$RAW/$slug/$vid".*vtt 2>/dev/null | head -1 || true)
      if [[ -n "$latest" && "$latest" != "$target" ]]; then
        mv -f "$latest" "$target" 2>/dev/null || true
      fi
    fi

    if [[ -s "$target" ]]; then
      echo "  ✅ $vid"; got=$((got+1))
    else
      echo "  ⚠️ $vid 无 EN 字幕,跳"
      echo "$row" >> "$skipped_log.tmp"
      skip=$((skip+1))
    fi
  done < <(jq -c '.[]' "$index")

  if [[ -s "$skipped_log.tmp" ]]; then
    jq -s '.' "$skipped_log.tmp" > "$skipped_log"
  fi
  rm -f "$skipped_log.tmp"
done

echo ""
echo "📊 总计: $total 个视频 / 拿到 $got / 跳过 $skip"
echo "下一步: export ANTHROPIC_API_KEY=sk-... && ./scripts/03_extract_takeaways.py"
