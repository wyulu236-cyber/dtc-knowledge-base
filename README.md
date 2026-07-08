# DTC Ads Knowledge Base

> Grace 的 DTC 投放方法论学习库 —— 从 10 个 YouTube 博主的视频里提炼 takeaway,做成可搜索可对比的网站。

## 这是什么

一个**完全本地**的静态网站,从你筛选过的 10 个 DTC 投放博主(Meta + Google)的视频字幕里,用 Claude 提炼出 takeaway,按主题/博主聚合,在浏览器里展示。

**不是 chatbot**。是知识库 —— 让你自己去看、去对比、去跳 YouTube 验证。

## 你需要做什么

### 第一次跑(20 分钟,大头是等)

```bash
# 1. 装工具
brew install yt-dlp jq

# 2. 配 API key (没有就去 https://console.anthropic.com/settings/keys 创建)
export ANTHROPIC_API_KEY=sk-ant-xxx
# 推荐写到 ~/.zshrc 永久生效:
# echo 'export ANTHROPIC_API_KEY=sk-ant-xxx' >> ~/.zshrc

cd ~/Desktop/dtc-knowledge-base

# 3. 跑 pipeline (按顺序)
./scripts/01_collect_video_urls.sh    # 抓 10 博主 × top 20 视频 URL (~2 分钟)
./scripts/02_download_subtitles.sh    # 抓 ~200 个英文字幕 (~10 分钟)
./scripts/03_extract_takeaways.py     # Claude 提炼 takeaway (~10 分钟, 花 ~$1)
./scripts/04_aggregate_topics.py      # 聚合数据 → site/assets/data.json (秒)

# 4. 启动网站
./site/start.sh
# 或者直接: cd site && python3 -m http.server 8080
# 然后浏览器打开 http://localhost:8080
```

### 调试用的小跑(只跑 1 个博主 × 3 个视频,验证打通)

```bash
# 改 channels.json 临时只留 1 个 (或者用 --only)
./scripts/03_extract_takeaways.py --only dara-denney --limit 3
./scripts/04_aggregate_topics.py
./site/start.sh
```

## 网站怎么用

打开 `http://localhost:8080`,你会看到:

| 页 | 你能干嘛 |
|---|---|
| **主页** | 看主题 grid + 博主 grid + 最新 takeaway |
| **主题页** | 比如点「Creative Testing」 → 看不同博主对同一话题的不同观点(Dara 怎么说 / Konstantinos 怎么说) |
| **博主页** | 看某博主所有 takeaway 的时间线 |
| **视频页** | 嵌入 YouTube,点 takeaway 的 ▶ 时间戳直接跳到那一秒 |
| **搜索** | 顶部搜索框 (按 `/` 聚焦) → fuzzy 搜 takeaway/博主/主题 |
| **过滤** | 主题页有「Amazon 相关度」筛选,选「Amazon✓ 高相关」就只看跟你现在场景能用的 |

## 加新博主

1. 编辑 `config/channels.json`,加一个新条目
2. 重跑 `01 → 02 → 03 → 04`(脚本是增量的,已处理的视频不会重复)
3. 刷新网站

## 配置说明

- `config/channels.json` —— 博主清单 + topic 白名单
- `scripts/03_extract_takeaways.py` 顶部的 `SYSTEM_PROMPT` —— 改提炼规则
- `scripts/04_aggregate_topics.py` 的 `TOPIC_META` —— 改主题中文名 / 描述

## 目录结构

```
dtc-knowledge-base/
├── README.md                 ← 你正在看
├── config/
│   └── channels.json         ← 博主清单
├── raw/                      ← yt-dlp 下的字幕 (.vtt) [脚本 02 生成]
├── meta/                     ← 视频 metadata [脚本 01 生成]
├── processed/                ← takeaway 数据 [脚本 03/04 生成]
├── scripts/                  ← pipeline (01→02→03→04)
└── site/                     ← 网站 (打开就能看)
    ├── index.html
    ├── start.sh              ← ./start.sh 启动本地预览
    └── assets/
        ├── style.css
        ├── app.js
        ├── search.js
        └── data.json         ← [脚本 04 生成的前端数据]
```

## 成本

- yt-dlp / jq / Python:免费
- Claude API:**~$1 一次全量**(claude-haiku-4-5,200 视频)
- 加新博主 / 重跑:增量,只算新视频的 token

## 已知限制(v1)

- 仅英文字幕(中文博主 v2 加,需另一组 yt-dlp `--sub-lang zh-CN` 参数 + prompt 调整)
- auto-generated 字幕偶有错词,quote 看着别扭就点 ▶ 跳 YouTube 自己听
- topic 标签是 Claude 提的,不一定 100% 准
- 视频按 view_count 排序;如果某博主没有 view_count(隐私设置),fallback 按上传顺序取最新 20

## 下一版可能加

- [ ] 中文博主(楚雪 / hwds868)
- [ ] localStorage 标记「已读 / 待看」
- [ ] 每周 monitor 模式(自动追新视频)
- [ ] 部署 Vercel 公网访问(3 行 vercel.json)
- [ ] Anki 卡片导出(把 takeaway 变成抽认卡)

## 出问题怎么办

| 现象 | 怎么处理 |
|---|---|
| `01.sh` 报错 dump 失败 | 检查 channels.json 里 `verify: true` 的几个 handle 是否对,去 YouTube 验证 |
| `02.sh` 大量「无 EN 字幕」 | 正常,部分视频确实没字幕。skipped.json 记着,跳过即可 |
| `03.py` HTTP 401 | API key 没设对,`echo $ANTHROPIC_API_KEY` 验证 |
| `03.py` HTTP 429 | API rate limit,脚本会自动 backoff 重试,等就行 |
| 网站 404「数据未生成」 | 没跑过 04,跑一下 |
| 网站打开是空的 | F12 开 console 看报错;通常是 data.json 路径问题或 fetch 被 CORS 拦(必须用 `python3 -m http.server` 跑,不能直接双击 html) |

## 信条

> 知识库的目的是**让人去看**,不是替人看。
> 看完每条 takeaway 都跳一次 YouTube,自己听,自己想,自己写到自己的 SOP 里。
> 不要把这个站当成「再也不用看 YouTube」的捷径 —— 它是 index,不是 substitute。
