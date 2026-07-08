#!/usr/bin/env bash
# scripts/01_collect_video_urls.sh
# 用 yt-dlp 抓每个博主的视频列表(top 20 by views,fallback latest 20)
# 输出: meta/<slug>/index.json + meta/<slug>/<video_id>.json
#
# 用法: ./scripts/01_collect_video_urls.sh
# 前置: 已 brew install yt-dlp jq

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/config/channels.json"
META="$ROOT/meta"
TOP_N=20

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "❌ yt-dlp 未安装。运行: brew install yt-dlp" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq 未安装。运行: brew install jq" >&2
  exit 1
fi

mkdir -p "$META"

# 读取 channels (排除 _ 开头的字段)
channels=$(jq -c '.channels[]' "$CONFIG")

while IFS= read -r ch; do
  slug=$(echo "$ch"      | jq -r '.slug')
  videos_url=$(echo "$ch"| jq -r '.videos_url')
  name=$(echo "$ch"      | jq -r '.name')
  echo "▶ [$slug] $name → $videos_url"
  mkdir -p "$META/$slug"

  # Step 1: --flat-playlist 拿全部视频列表(只 metadata,不下载)
  raw="$META/$slug/_raw_dump.jsonl"
  if ! yt-dlp --flat-playlist --dump-json --quiet --no-warnings \
        "$videos_url" > "$raw" 2>"$META/$slug/_dump_err.log"; then
    echo "  ⚠️ dump 失败,err 见 $META/$slug/_dump_err.log。跳过此博主。" >&2
    continue
  fi

  count=$(wc -l < "$raw" | tr -d ' ')
  echo "  · 抓到 $count 个视频"

  # Step 2: 排序 — 优先 view_count 倒序,缺失则按列表顺序(yt-dlp 默认按上传时间倒序)
  jq -s --argjson n "$TOP_N" '
    sort_by(.view_count // 0) | reverse | .[0:$n]
    | map({
        id: .id,
        title: .title,
        url: (.url // ("https://www.youtube.com/watch?v=" + .id)),
        duration: .duration,
        view_count: .view_count,
        upload_date: .upload_date,
        thumbnail: .thumbnail,
        channel_slug: "'"$slug"'"
      })
  ' "$raw" > "$META/$slug/index.json"

  picked=$(jq 'length' "$META/$slug/index.json")
  echo "  ✅ index.json: $picked 个 top 视频"

  rm -f "$raw"
done <<< "$channels"

echo ""
echo "🎉 完成。检查每个 meta/<slug>/index.json 是否合理。"
echo "下一步: ./scripts/02_download_subtitles.sh"
