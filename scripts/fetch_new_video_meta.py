#!/usr/bin/env python3
# scripts/fetch_new_video_meta.py
# 桥接: discover_new_videos.py 找到的新 video_id → 用 yt-dlp 拉 metadata + subs。
# 输入:  meta/_new_videos.json
# 输出:  raw/<slug>/<vid>.en.vtt + 更新 meta/<slug>/index.json (追加,不覆盖)
#
# 过滤规则 (跟 GitHub workflow 里的 --match-filter 一致,双保险):
#   - duration > 90  →  Short 通常 < 60s, ≤ 90s 一律 skip
#   - !is_live       →  正在直播的不要
#   - live_status != 'is_upcoming'  →  预告的不要
#
# 幂等:
#   - 已存在的 .en.vtt 不重复下
#   - index.json 只 append 没见过的 video_id

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
META = ROOT / "meta"
RAW = ROOT / "raw"
NEW_LIST = META / "_new_videos.json"

MATCH_FILTER = "duration > 90 & !is_live & live_status != 'is_upcoming'"


def yt_dlp_json(url: str) -> dict | None:
    """跑 yt-dlp 拿单视频 metadata JSON。带 --match-filter → 被过滤的返回 None。"""
    try:
        out = subprocess.check_output(
            [
                "yt-dlp",
                "--dump-json",
                "--no-warnings",
                "--quiet",
                "--skip-download",
                "--match-filter", MATCH_FILTER,
                url,
            ],
            stderr=subprocess.PIPE,
            timeout=60,
        )
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="ignore")
        # match-filter 命中时 yt-dlp 返回非 0,不当错误看
        if "does not pass filter" in stderr or "matches filter" in stderr:
            return None
        print(f"    ! yt-dlp meta 失败: {stderr[:200]}", file=sys.stderr)
        return None
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"    ! {e}", file=sys.stderr)
        return None
    text = out.decode("utf-8", errors="ignore").strip()
    if not text:
        return None
    try:
        return json.loads(text.splitlines()[0])
    except json.JSONDecodeError:
        return None


def yt_dlp_subs(url: str, out_dir: Path) -> bool:
    """拉 EN 字幕 (manual 优先,fallback auto-gen)。返回是否成功。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.check_call(
            [
                "yt-dlp",
                "--write-subs",
                "--write-auto-subs",
                "--sub-lang", "en",
                "--sub-format", "vtt",
                "--skip-download",
                "--no-warnings",
                "--quiet",
                "-o", str(out_dir / "%(id)s.%(ext)s"),
                url,
            ],
            stderr=subprocess.DEVNULL,
            timeout=90,
        )
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return False


def load_index(slug: str) -> list:
    p = META / slug / "index.json"
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except Exception:
        return []


def save_index(slug: str, entries: list):
    p = META / slug / "index.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".new.json")
    tmp.write_text(json.dumps(entries, ensure_ascii=False, indent=2))
    os.replace(tmp, p)


def load_skipped(slug: str) -> dict:
    """{video_id: {reason, tried_at}} — 之前拉挂过的视频,discover 层会当作 existing 跳掉。
    没有这个持久化, RSS 每天都返回它, 每天都花 yt-dlp 一次去重复失败。"""
    p = META / slug / "skipped.json"
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text())
        # 兼容: 老版本(02_download_subtitles.sh)是 array,新版本 dict
        if isinstance(raw, list):
            return {r.get("id", ""): {"reason": "legacy", "tried_at": ""} for r in raw if r.get("id")}
        if isinstance(raw, dict):
            return raw
        return {}
    except Exception:
        return {}


def save_skipped(slug: str, skipped: dict):
    p = META / slug / "skipped.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".new.json")
    tmp.write_text(json.dumps(skipped, ensure_ascii=False, indent=2))
    os.replace(tmp, p)


def main():
    if not NEW_LIST.exists():
        print(f"❌ {NEW_LIST} 不存在, 先跑 discover_new_videos.py", file=sys.stderr)
        sys.exit(1)

    new_items = json.loads(NEW_LIST.read_text())
    if not new_items:
        print("· 没有新视频, 退出")
        return

    # 按 slug 归组
    by_slug = {}
    for item in new_items:
        by_slug.setdefault(item["slug"], []).append(item)

    total_added = 0
    total_filtered = 0
    total_failed = 0

    for slug, items in by_slug.items():
        print(f"\n▶ [{slug}] {len(items)} 个候选")
        index_entries = load_index(slug)
        existing_ids = {v["id"] for v in index_entries}
        skipped = load_skipped(slug)
        # 把之前跳过的 id 也当 existing:下轮 discover 会 skip,workflow 不再浪费 yt-dlp
        existing_ids.update(skipped.keys())

        new_index_entries = []
        skipped_changed = False
        for item in items:
            vid = item["video_id"]
            url = item["url"]
            if vid in existing_ids:
                print(f"  · {vid} 已在 index/skipped, 跳"); continue

            meta = yt_dlp_json(url)
            if meta is None:
                # 可能是 short / live / upcoming, 静默 skip → 但要记住, 别每天重试
                print(f"  ⊘ {vid} 被 filter 过滤 (short/live/upcoming) 或拉 meta 失败")
                skipped[vid] = {
                    "reason": "filter_or_meta_fail",
                    "tried_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
                skipped_changed = True
                total_filtered += 1
                continue

            # 拉字幕
            ok = yt_dlp_subs(url, RAW / slug)
            target = RAW / slug / f"{vid}.en.vtt"
            # yt-dlp 输出可能是 <id>.en.vtt 或 <id>.en-en.vtt
            if not target.exists():
                # 找同 id 前缀的其它 vtt
                candidates = sorted((RAW / slug).glob(f"{vid}*.vtt"))
                if candidates:
                    candidates[0].rename(target)
            if not target.exists() or target.stat().st_size == 0:
                print(f"  ⚠️ {vid} 无 EN 字幕, 记入 skipped.json (下次不再尝试)")
                skipped[vid] = {
                    "reason": "no_en_subs",
                    "tried_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "title": meta.get("title", "")[:120],
                }
                skipped_changed = True
                total_failed += 1
                continue

            new_index_entries.append({
                "id": vid,
                "title": meta.get("title", item.get("title", "")),
                "url": url,
                "duration": meta.get("duration") or 0,
                "view_count": meta.get("view_count") or 0,
                "upload_date": meta.get("upload_date", ""),
                "thumbnail": meta.get("thumbnail", ""),
                "channel_slug": slug,
            })
            existing_ids.add(vid)
            print(f"  ✅ {vid} ({meta.get('title','')[:60]})")

        if new_index_entries:
            # 新的排前面 (按 upload_date 倒序, 保证首页看到最新)
            merged = new_index_entries + index_entries
            save_index(slug, merged)
            total_added += len(new_index_entries)
            print(f"  → 写入 index.json (新 {len(new_index_entries)} / 总 {len(merged)})")
        if skipped_changed:
            save_skipped(slug, skipped)
            print(f"  → 写入 skipped.json ({len(skipped)} 个不再重试的 id)")

    print(f"\n🎉 新增 {total_added}, 过滤 {total_filtered}, 失败 {total_failed}")


if __name__ == "__main__":
    main()
