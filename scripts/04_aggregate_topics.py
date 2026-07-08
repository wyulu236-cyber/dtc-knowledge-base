#!/usr/bin/env python3
# scripts/04_aggregate_topics.py
# 把 takeaways.json 聚合成 topics.json + channels.json (网站直接读)
# 顺便整合一份 site/assets/data.json (前端唯一入口)

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict, Counter

ROOT = Path(__file__).resolve().parent.parent
PROCESSED = ROOT / "processed"
SITE_ASSETS = ROOT / "site" / "gracexiaoe" / "assets"

CONFIG = json.loads((ROOT / "config" / "channels.json").read_text())
TOPICS = CONFIG["_topics_whitelist"]
CHANNELS_CFG = {c["slug"]: c for c in CONFIG["channels"]}

# Topic 中文名 + 描述 (写死,Grace 想改直接编辑这个映射)
TOPIC_META = {
    "P-Max":             {"label_zh": "Performance Max",   "desc": "Google P-Max 全自动战役: 资产组合 / signal / 排除 / 报告"},
    "Advantage+":        {"label_zh": "Advantage+",        "desc": "Meta Advantage+ shopping/audience: 何时开 / 怎么 feed / 怎么读数"},
    "creative-testing":  {"label_zh": "Creative Testing",  "desc": "Hook / 缩略图 / iteration / winner 判定 / 测试预算"},
    "scaling":           {"label_zh": "Scaling",            "desc": "扩量节奏: spend wall / horizontal vs vertical / 撤回信号"},
    "attribution":       {"label_zh": "归因 Attribution",  "desc": "Conversion API / match rate / 跨平台冲突 / 7-day click"},
    "negative-keywords": {"label_zh": "Negative Keywords", "desc": "屏蔽词清单 / SQR 复盘 / brand vs generic"},
    "bidding":           {"label_zh": "Bidding 策略",       "desc": "tCPA / tROAS / Max Conv vs Max Conv Value / 切换时机"},
    "audience":          {"label_zh": "受众",                "desc": "broad vs interest / lookalike / 排除 / 信号 vs 限制"},
    "campaign-structure":{"label_zh": "结构搭建",           "desc": "campaign / adset / ad 层级: 拆 vs 合 / 命名规范"},
    "reporting":         {"label_zh": "报表",                "desc": "看哪些字段 / 哪些不要看 / 多账户合并报表"},
    "copy":              {"label_zh": "广告文案",           "desc": "Hook 公式 / CTA / 跨平台改写 / Headline test"},
    "landing-page":      {"label_zh": "落地页",              "desc": "速度 / above-fold / 移动端 / Amazon listing 优化"},
    "budget":            {"label_zh": "预算分配",           "desc": "CBO vs ABO / 占比 / 周内分布 / 紧急刹车"},
    "optimization":      {"label_zh": "优化操作",           "desc": "日常调整 sop / 哪些不要碰 / 学习期 (Learning Phase)"},
    "analytics":         {"label_zh": "数据分析",           "desc": "GA4 / 自定义事件 / cohort / LTV"},
    "brand":             {"label_zh": "品牌 vs 转化",       "desc": "Brand bid / 品牌词预算 / 品牌防守"},
    "niche":             {"label_zh": "垂类专精",           "desc": "B2B / DTC / coaching / e-com 不同打法"},
}


def main():
    takeaways = json.loads((PROCESSED / "takeaways.json").read_text())
    print(f"📥 读到 {len(takeaways)} 条 takeaway")

    # ---- topics.json ----
    by_topic = defaultdict(list)
    for t in takeaways:
        for tp in t["topics"]:
            by_topic[tp].append(t["id"])

    topics_out = []
    for tp in TOPICS:
        ids = by_topic.get(tp, [])
        # 该 topic 下覆盖了哪些博主
        ch_set = sorted({t["channel_slug"] for t in takeaways if tp in t["topics"]})
        meta = TOPIC_META.get(tp, {"label_zh": tp, "desc": ""})
        topics_out.append({
            "slug": tp,
            "label_zh": meta["label_zh"],
            "desc": meta["desc"],
            "takeaway_count": len(ids),
            "channels_covered": ch_set,
            "takeaway_ids": ids,
        })

    (PROCESSED / "topics.json").write_text(json.dumps(topics_out, ensure_ascii=False, indent=2))

    # ---- channels.json (processed: 含统计) ----
    channels_out = []
    for slug, ch in CHANNELS_CFG.items():
        ch_takeaways = [t for t in takeaways if t["channel_slug"] == slug]
        topic_counter = Counter()
        for t in ch_takeaways:
            for tp in t["topics"]:
                topic_counter[tp] += 1
        channels_out.append({
            "slug": slug,
            "name": ch["name"],
            "handle": ch.get("handle", ""),
            "url": ch["url"],
            "platform": ch.get("platform", ""),
            "role": ch.get("role", ""),
            "why": ch.get("why", ""),
            "takeaway_count": len(ch_takeaways),
            "video_count": len({t["video_id"] for t in ch_takeaways}),
            "top_topics": [{"slug": tp, "count": n} for tp, n in topic_counter.most_common(5)],
            "amazon_relevance_dist": dict(Counter(t["amazon_relevance"] for t in ch_takeaways)),
        })

    (PROCESSED / "channels.json").write_text(json.dumps(channels_out, ensure_ascii=False, indent=2))

    # ---- video index (用于视频详情页 嵌入) ----
    META = ROOT / "meta"
    videos_out = []
    for ch_dir in sorted(META.glob("*/index.json")):
        slug = ch_dir.parent.name
        for v in json.loads(ch_dir.read_text()):
            videos_out.append({
                "id": v["id"],
                "title": v.get("title", ""),
                "url": v.get("url", ""),
                "duration": v.get("duration") or 0,
                "thumbnail": v.get("thumbnail", ""),
                "channel_slug": slug,
                "view_count": v.get("view_count") or 0,
                "upload_date": v.get("upload_date", ""),
            })

    # ---- site/assets/data.json (前端单一数据源) ----
    # 原子写入: 先写 data.new.json,os.replace() 一次性覆盖。
    # 避免 workflow / CI 中途 kill 时留下半个 JSON 让前端拿到 SyntaxError。
    # generated_at 强制 UTC + Z, 前端 parseLocalDate() 会拆 YYYY-MM-DD 段,不受读者时区影响。
    SITE_ASSETS.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "topic_meta": TOPIC_META,
        "topics": topics_out,
        "channels": channels_out,
        "videos": videos_out,
        "takeaways": takeaways,
    }
    data_path = SITE_ASSETS / "data.json"
    tmp_path = SITE_ASSETS / "data.new.json"
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False))
    os.replace(tmp_path, data_path)

    print(f"✅ topics.json: {len(topics_out)} topics")
    print(f"✅ channels.json: {len(channels_out)} channels")
    print(f"✅ site/gracexiaoe/assets/data.json: {len(takeaways)} takeaways · {len(videos_out)} videos")
    print(f"\n下一步: cd site && python3 -m http.server 8080  → 浏览器开 http://localhost:8080/gracexiaoe/")


if __name__ == "__main__":
    main()
