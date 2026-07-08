#!/usr/bin/env python3
"""
06_rewrite_takeaways.py — 把冗长的 summary_zh 重写成 tldr + bullets + amazon_tip

用法:
    python3 scripts/06_rewrite_takeaways.py --limit 3       # 试跑前 3 条,不写盘,打印对比
    python3 scripts/06_rewrite_takeaways.py --limit 3 --commit  # 试跑前 3 条并写盘
    python3 scripts/06_rewrite_takeaways.py --commit         # 全量,写盘,断点续跑(已有 tldr 的跳过)
    python3 scripts/06_rewrite_takeaways.py --commit --targets official  # 只跑官方动态

环境变量: ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY (由 zshrc 提供)
"""
import argparse, json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "site/gracexiaoe/assets/data.json"
BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "").rstrip("/")
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MODEL = "claude-sonnet-4-5-20250929"

SYSTEM_PROMPT = """你是一名 DTC 广告投放教练。用户会给你一条投放视频的中文详解和英文原句,你需要重写成极简可查阅格式,便于快速扫读。

产出严格 JSON(不要任何 markdown 代码块、不要前后文字):
{
  "tldr": "一句话核心结论,≤40 字",
  "bullets": ["≤25 字的判断/取舍/红线", "另一条", "第三条"],
  "amazon_tip": "Amazon 场景启示,≤35 字;如果原文没提到 Amazon 场景就返回空字符串"
}

【硬规则】(违反重跑)
1. bullets 之间必须信息互斥,禁止同一判断换措辞重复;宁可只出 2 条也不凑数
2. TLDR 必须保留原文里的量化条件/双层结构(如 "campaign 和 ad group 两层"、"高竞争 + 高 CPC 双条件"、"预算 X 之上 vs 之下"),严禁把双条件简化成单条件
3. bullets 只出"判断/取舍/红线",不要写"数据来源解释""操作步骤""为什么"
4. 去掉 "Aaron 强调" / "原理:" / "他的做法是" / "他不直接" 这类描述性套话,只留干货
5. TLDR 不要重复标题内容
6. 保留数字、平台名、专业术语(P-Max / CPC / ACoS / SP / broad match 等原文原样)
7. amazon_tip 只从原详解里提取,不要臆造;原文没提就返回空字符串
8. 只输出 JSON,不要任何解释

【正例】
标题: 选词只看 trend 不看绝对值, 高竞争 + 高 CPC 直接砍
详解: Keyword Planner 给的 monthly search / competition / top of page bid 都只反映过去趋势, 不是未来确定值。Aaron 决策方法: 高 search volume + low/medium competition + 可承受 CPC 的留下; 像 pest control 这种泛词竞争和单价都极高就主动放弃, 用 pest control + 地区 这种 mid-tail 词更划算。Amazon 启示: SP keyword 选词同理...
好输出:
{
  "tldr": "高 competition + 高 CPC 双条件同时命中的泛词直接砍,mid-tail 更划算",
  "bullets": [
    "留下条件:高 volume + 低/中 competition + 可承受 CPC",
    "砍掉条件:泛词竞争+单价双高(如 pest control)",
    "替换:泛词 + 地区/品类修饰的 mid-tail 词"
  ],
  "amazon_tip": "SP 避开 head term(如 water bottle),用材质/品类 long-tail 降 ACoS"
}
"""


def call_api(user_content: str, retries: int = 6) -> dict:
    payload = {
        "model": MODEL,
        "max_tokens": 500,
        "system": [
            {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}
        ],
        "messages": [{"role": "user", "content": user_content}],
    }
    for attempt in range(retries + 1):
        try:
            r = subprocess.run(
                [
                    "curl", "-sS", "--max-time", "60",
                    "-X", "POST", f"{BASE_URL}/v1/messages",
                    "-H", f"x-api-key: {API_KEY}",
                    "-H", "anthropic-version: 2023-06-01",
                    "-H", "content-type: application/json",
                    "-d", json.dumps(payload, ensure_ascii=False),
                ],
                capture_output=True, text=True, check=True,
            )
            resp = json.loads(r.stdout)
            if "content" not in resp:
                err_msg = json.dumps(resp, ensure_ascii=False)
                # relay RPM 限流:每分钟 20 请求,撞到就等 65 秒
                if "RPM" in err_msg or "rate" in err_msg.lower() or "限制" in err_msg:
                    if attempt < retries:
                        time.sleep(65)
                        continue
                raise RuntimeError(f"API 错误响应: {resp}")
            text = resp["content"][0]["text"].strip()
            m = re.search(r"\{[\s\S]*\}", text)
            if not m:
                raise RuntimeError(f"响应里找不到 JSON: {text[:200]}")
            parsed = json.loads(m.group(0))
            assert "tldr" in parsed and parsed["tldr"], "tldr 缺失"
            assert "bullets" in parsed and isinstance(parsed["bullets"], list) and 2 <= len(parsed["bullets"]) <= 5, "bullets 结构错误"
            assert "amazon_tip" in parsed, "amazon_tip 字段缺失"
            return parsed
        except Exception as e:
            if attempt >= retries:
                raise
            # 一般错误:短退避
            time.sleep(min(3 * (attempt + 1), 15))


def rewrite_takeaway(t: dict) -> dict:
    user_content = (
        f"标题: {t['title_zh']}\n"
        f"详解: {t['summary_zh']}\n"
        f"英文原句: {t.get('quote_en', '')}"
    )
    return call_api(user_content)


def rewrite_official(u: dict) -> dict:
    user_content = (
        f"标题: {u['title_zh']}\n"
        f"详解: {u['summary_zh']}\n"
        f"Amazon 落地理由: {u.get('amazon_actionable_reason_zh', '')}"
    )
    return call_api(user_content)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 条,0=全量")
    ap.add_argument("--commit", action="store_true", help="累积结果到 --output;否则只 dry-run 打印")
    ap.add_argument("--targets", default="takeaways,official", help="逗号分隔: takeaways / official")
    ap.add_argument("--concurrency", type=int, default=5)
    ap.add_argument("--force", action="store_true", help="即使已有 tldr 也重跑")
    ap.add_argument("--output", default=os.environ.get("TMPDIR", "/tmp") + "rewrite_results.json",
                    help="结果落盘路径(不写 data.json,方便主进程用 Write 工具合并)")
    args = ap.parse_args()

    if not BASE_URL or not API_KEY:
        sys.exit("缺少 ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY 环境变量")

    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    targets = [x.strip() for x in args.targets.split(",") if x.strip()]

    # 累积结果 {kind: {id: rewrite_dict}} 便于主进程合并
    all_results = {}
    if args.commit and Path(args.output).exists():
        try:
            all_results = json.loads(Path(args.output).read_text(encoding="utf-8"))
        except Exception:
            all_results = {}

    def process(field_name: str, items: list, worker):
        pending = [i for i, x in enumerate(items) if args.force or "tldr" not in x]
        # 已在 output 里的也算完成
        kind_bucket = all_results.setdefault(field_name, {})
        pending = [i for i in pending if items[i]["id"] not in kind_bucket]
        if args.limit:
            pending = pending[: args.limit]
        total = len(pending)
        if total == 0:
            print(f"[{field_name}] 全部已完成,跳过")
            return 0
        print(f"[{field_name}] 待处理 {total}/{len(items)} 条(已完成 {len(kind_bucket)})")

        done = 0
        results = {}
        with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
            futures = {ex.submit(worker, items[idx]): idx for idx in pending}
            for fut in as_completed(futures):
                idx = futures[fut]
                try:
                    parsed = fut.result()
                    results[idx] = parsed
                    kind_bucket[items[idx]["id"]] = parsed
                    done += 1
                    print(f"[{field_name}] {done}/{total} ✓ {items[idx]['title_zh'][:40]}")
                except Exception as e:
                    print(f"[{field_name}] ✗ id={items[idx].get('id')} {e}", file=sys.stderr)

                # 每 5 条落盘一次(断点续跑)
                if args.commit and done and done % 5 == 0:
                    Path(args.output).write_text(json.dumps(all_results, ensure_ascii=False, indent=2), encoding="utf-8")

        if args.commit:
            Path(args.output).write_text(json.dumps(all_results, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[{field_name}] 已落盘 -> {args.output}")
        else:
            print(f"\n=== dry-run 预览 ({field_name}) ===")
            for i, r in list(results.items())[:5]:
                orig = items[i]
                print(f"\n[{orig['id']}] {orig['title_zh']}")
                print(f"  原详解({len(orig['summary_zh'])}字): {orig['summary_zh']}")
                print(f"  ---")
                print(f"  🎯 TLDR: {r['tldr']}")
                print(f"  📌 Bullets:")
                for b in r['bullets']:
                    print(f"     • {b}")
                if r.get('amazon_tip'):
                    print(f"  🛒 Amazon: {r['amazon_tip']}")
        return done

    if "takeaways" in targets:
        process("takeaways", data["takeaways"], rewrite_takeaway)
    if "official" in targets:
        process("official", data["official_updates"], rewrite_official)


if __name__ == "__main__":
    main()
