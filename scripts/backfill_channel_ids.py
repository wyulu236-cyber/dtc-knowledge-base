#!/usr/bin/env python3
# scripts/backfill_channel_ids.py
# 给 config/channels.json 里每个博主补 channel_id (UC...)。
# YouTube RSS 只吃 channel_id 不吃 @handle,所以 discover_new_videos.py 依赖这个字段。
#
# 用法:
#   ./scripts/backfill_channel_ids.py
# 前置:
#   - brew install yt-dlp jq (jq 只在 shell fallback 里用,Python 版不需要)
#   - 得能连 youtube.com

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "channels.json"


def probe_channel_id(handle_url: str) -> str | None:
    """yt-dlp 拉频道第 1 个视频,读它的 channel_id。--playlist-items 1 只吃 1 条。"""
    try:
        out = subprocess.check_output(
            [
                "yt-dlp",
                "--flat-playlist",
                "--playlist-items", "1",
                "--dump-json",
                "--quiet",
                "--no-warnings",
                handle_url,
            ],
            stderr=subprocess.PIPE,
            timeout=45,
        )
    except subprocess.CalledProcessError as e:
        print(f"  ! yt-dlp 失败: {e.stderr.decode('utf-8', errors='ignore')[:200]}", file=sys.stderr)
        return None
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"  ! {e}", file=sys.stderr)
        return None
    try:
        data = json.loads(out.decode("utf-8"))
        # 视频级返回里 channel_id 就在顶层
        ch_id = data.get("channel_id") or data.get("uploader_id")
        if ch_id and str(ch_id).startswith("UC"):
            return ch_id
        # fallback: 某些老版本 yt-dlp 只返回 "@handle"
        return None
    except json.JSONDecodeError:
        return None


def main():
    config = json.loads(CONFIG_PATH.read_text())
    changed = 0
    missing = []

    for ch in config["channels"]:
        slug = ch["slug"]
        if ch.get("channel_id"):
            print(f"· [{slug}] 已有 {ch['channel_id']}, 跳")
            continue

        url = ch.get("url") or ch.get("videos_url")
        if not url:
            print(f"⚠️ [{slug}] 没有 url, 跳", file=sys.stderr)
            missing.append(slug)
            continue

        print(f"▶ [{slug}] 探测 channel_id...")
        ch_id = probe_channel_id(url)
        if ch_id:
            ch["channel_id"] = ch_id
            changed += 1
            print(f"  ✅ {ch_id}")
        else:
            missing.append(slug)
            print(f"  ❌ 探测失败")

    if changed:
        # 保留 json 原有键顺序 + 缩进,方便 Grace review diff
        CONFIG_PATH.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
        print(f"\n✅ 更新 {changed} 个 channel_id, 已写回 {CONFIG_PATH}")
    else:
        print("\n· 没有需要更新的 channel_id")

    if missing:
        print(f"\n⚠️ {len(missing)} 个博主未拿到 channel_id: {', '.join(missing)}")
        print("   → 手动去 https://www.youtube.com/@<handle> 查看源码,搜 'externalId' 拿 UC... 填进去")
        sys.exit(1)


if __name__ == "__main__":
    main()
