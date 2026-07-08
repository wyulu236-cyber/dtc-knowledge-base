#!/usr/bin/env python3
# scripts/discover_new_videos.py
# 每天 07:00 UTC 由 GitHub Action 触发。任务:
#   - 拉每个博主 YouTube RSS feed (需要 channel_id, 即 UC...)
#   - 跟本地 meta/<slug>/index.json 对差
#   - 输出 meta/_new_videos.json (给下一步 yt-dlp 下 metadata + subs 用)
# stdlib only (urllib + xml),不要 pip install。
#
# 关键设计:
#   - RSS 会同时暴露 Shorts / Live / upcoming, RSS 层不过滤, 留给 yt-dlp
#     --match-filter "duration > 90 & !is_live & live_status != 'is_upcoming'"
#   - channel_id 从 config/channels.json 读; 若缺失, 提示先跑 backfill_channel_ids.py
#   - RSS 只返回最近 ~15 条; 更早的历史视频靠 01_collect_video_urls.sh 全量补
#   - 幂等: 同一天跑两次结果一致 (基于 index.json 中现有 video_id 做差集)

import json
import sys
from pathlib import Path
from urllib import request, error
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "channels.json"
META = ROOT / "meta"

RSS_TEMPLATE = "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"

# YouTube RSS 用 Atom + media 命名空间
NS = {
    "atom":  "http://www.w3.org/2005/Atom",
    "yt":    "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}


def fetch_rss(channel_id: str, timeout: int = 30) -> str:
    """拉 RSS XML。403/404 抛 HTTPError,由 caller 记 fail_log。"""
    url = RSS_TEMPLATE.format(channel_id=channel_id)
    # UA: 部分 CDN 对空 UA 拒绝
    req = request.Request(url, headers={"User-Agent": "dtc-kb-discover/1.0"})
    with request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def parse_rss(xml_text: str) -> list:
    """RSS entry → [{video_id, title, published, url}]。"""
    root = ET.fromstring(xml_text)
    out = []
    for entry in root.findall("atom:entry", NS):
        vid_el = entry.find("yt:videoId", NS)
        title_el = entry.find("atom:title", NS)
        published_el = entry.find("atom:published", NS)
        link_el = entry.find("atom:link", NS)
        if vid_el is None or vid_el.text is None:
            continue
        vid = vid_el.text.strip()
        url = link_el.get("href") if link_el is not None else f"https://www.youtube.com/watch?v={vid}"
        out.append({
            "video_id": vid,
            "title": (title_el.text or "").strip() if title_el is not None else "",
            "published": (published_el.text or "").strip() if published_el is not None else "",
            "url": url,
        })
    return out


def load_existing_ids(slug: str) -> set:
    """读 meta/<slug>/index.json + skipped.json,把已收录 / 已确认放弃的 video_id 拿出来。
    skipped 也要算入,否则 RSS 每天都返回这些 id,workflow 每天都要多一轮 yt-dlp 才发现"无字幕"。"""
    ids = set()
    idx = META / slug / "index.json"
    if idx.exists():
        try:
            ids.update(v["id"] for v in json.loads(idx.read_text()) if v.get("id"))
        except Exception as e:
            print(f"  ⚠️ 读 {idx} 失败: {e}", file=sys.stderr)
    skipped_path = META / slug / "skipped.json"
    if skipped_path.exists():
        try:
            raw = json.loads(skipped_path.read_text())
            if isinstance(raw, dict):
                ids.update(raw.keys())
            elif isinstance(raw, list):
                # 老格式: [{id, ...}]
                ids.update(r["id"] for r in raw if isinstance(r, dict) and r.get("id"))
        except Exception as e:
            print(f"  ⚠️ 读 {skipped_path} 失败: {e}", file=sys.stderr)
    return ids


def main():
    config = json.loads(CONFIG_PATH.read_text())
    channels = config["channels"]

    new_videos = []       # 给下一步 yt-dlp 用
    report = []           # 摘要,写入 _discover_report.json
    channels_missing_id = []

    for ch in channels:
        slug = ch["slug"]
        name = ch.get("name", slug)
        channel_id = ch.get("channel_id")

        if not channel_id:
            channels_missing_id.append(slug)
            report.append({"slug": slug, "status": "missing_channel_id", "new_count": 0})
            print(f"⚠️ [{slug}] {name} — 缺 channel_id, 先跑 backfill_channel_ids.py")
            continue

        try:
            xml_text = fetch_rss(channel_id)
        except error.HTTPError as e:
            report.append({"slug": slug, "status": f"http_{e.code}", "new_count": 0})
            print(f"❌ [{slug}] RSS HTTP {e.code}", file=sys.stderr)
            continue
        except (error.URLError, TimeoutError) as e:
            report.append({"slug": slug, "status": "net_error", "error": str(e)[:120], "new_count": 0})
            print(f"❌ [{slug}] RSS net error: {e}", file=sys.stderr)
            continue
        except ET.ParseError as e:
            report.append({"slug": slug, "status": "parse_error", "error": str(e)[:120], "new_count": 0})
            print(f"❌ [{slug}] RSS parse error: {e}", file=sys.stderr)
            continue

        try:
            entries = parse_rss(xml_text)
        except Exception as e:
            report.append({"slug": slug, "status": "parse_error", "error": str(e)[:120], "new_count": 0})
            print(f"❌ [{slug}] entries parse error: {e}", file=sys.stderr)
            continue

        existing = load_existing_ids(slug)
        new_here = [e for e in entries if e["video_id"] not in existing]

        # 附加 slug 方便下一步
        for e in new_here:
            e["slug"] = slug
        new_videos.extend(new_here)

        report.append({
            "slug": slug,
            "status": "ok",
            "rss_total": len(entries),
            "existing_total": len(existing),
            "new_count": len(new_here),
            "new_video_ids": [e["video_id"] for e in new_here],
        })
        marker = "🆕" if new_here else "· "
        print(f"{marker} [{slug}] {name} — RSS {len(entries)} / 已录 {len(existing)} / 新 {len(new_here)}")

    # 写出结果
    META.mkdir(exist_ok=True)
    new_path = META / "_new_videos.json"
    report_path = META / "_discover_report.json"

    new_path.write_text(json.dumps(new_videos, ensure_ascii=False, indent=2))
    report_path.write_text(json.dumps({
        "generated_at": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "channels_missing_channel_id": channels_missing_id,
        "channels": report,
    }, ensure_ascii=False, indent=2))

    total_new = len(new_videos)
    print(f"\n🎯 共发现 {total_new} 个新视频, 写入:")
    print(f"   {new_path}")
    print(f"   {report_path}")
    if channels_missing_id:
        print(f"\n⚠️  {len(channels_missing_id)} 个博主还没 channel_id: {', '.join(channels_missing_id)}")
        print(f"   → ./scripts/backfill_channel_ids.py")

    # exit code 语义:
    #   0  = 有新视频 / 或成功但没新视频 (workflow 用 git diff 决定要不要开 PR)
    #   2  = 网络/解析类失败 (workflow 应 fail loud, Grace 收飞书告警)
    fail_count = sum(1 for r in report if r["status"] not in ("ok", "missing_channel_id"))
    if fail_count and fail_count == len([r for r in report if r["status"] != "missing_channel_id"]):
        # 全部有 channel_id 的博主都失败 = 网络或 YouTube 挂了
        print(f"\n❌ 所有 {fail_count} 个博主都拉失败, 退出码 2", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
