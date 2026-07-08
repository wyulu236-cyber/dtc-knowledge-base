#!/usr/bin/env node
// answer-server.js — Grace 小助手 Phase 2 后端
// 浏览器问问题 → 服务端做 fuse 检索 → 调公司 relay (Anthropic API 兼容) → 返回结构化答案
//
// 启动: ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN 必须在 env (Grace 的 zshrc 已 export)
//   node scripts/answer-server.js
// 默认监听 127.0.0.1:8081 ; CORS 放行 http://localhost:8080

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'site/gracexiaoe/assets/data.json');
const PORT = Number(process.env.ANSWER_PORT || 8081);
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:8080';

const BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANSWER_MODEL || 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 1500;

if (!AUTH_TOKEN) {
  console.error('❌ ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 都没设置. 在 zshrc 里 export 后重启 shell.');
  process.exit(1);
}

// ---- 加载语料 ----
const DATA = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
console.log(`✓ 语料已载入: ${DATA.takeaways.length} 条 takeaway + ${(DATA.official_updates || []).length} 条官方动态`);
console.log(`  Relay: ${BASE_URL}  Model: ${MODEL}`);

// ---- 双语术语词典 (与 assistant.js 一致, 复刻关键条目) ----
const GLOSSARY = [
  ['精确匹配', 'exact match'], ['短语匹配', 'phrase match'], ['广泛匹配', 'broad match'], ['匹配类型', 'match type'],
  ['同义词匹配', 'close variant'], ['近似词', 'close variant'],
  ['关键词', 'keyword'], ['否定词', 'negative keyword'], ['负关键词', 'negative keyword'],
  ['屏蔽词', 'negative keyword'], ['搜索词', 'search term'], ['搜索词报告', 'search term report'],
  ['广告组', 'ad group'], ['广告系列', 'campaign'], ['资产组', 'asset group'],
  ['相互竞价', 'cannibalization compete'], ['自相残杀', 'cannibalization self-cannibalization'],
  ['互相争抢', 'cannibalization compete overlap'], ['关键词重叠', 'keyword overlap cannibalization'],
  ['出价', 'bid bidding'], ['手动出价', 'manual cpc'], ['智能出价', 'smart bidding'],
  ['目标 cpa', 'tcpa target cpa'], ['目标 roas', 'troas target roas'],
  ['创意', 'creative'], ['素材', 'creative'], ['钩子', 'hook hook rate'], ['前 3 秒', 'hook first 3 seconds'],
  ['缩略图', 'thumbnail'], ['标题', 'headline title'], ['文案', 'copy'],
  ['受众', 'audience'], ['类似受众', 'lookalike lal'], ['受众饱和', 'audience saturation fatigue'],
  ['再营销', 'remarketing retargeting'], ['重定向', 'retargeting'],
  ['冷启动', 'cold start prospecting new account'],
  ['归因', 'attribution'], ['归因窗口', 'attribution window'],
  ['7 天点击', '7 day click'], ['14 天点击', '14 day click'], ['view through', 'view-through'],
  ['落地页', 'landing page lp'], ['转化率', 'conversion rate cvr'], ['转化', 'conversion'], ['漏斗', 'funnel'],
  ['谷歌', 'google google ads'], ['脸书', 'meta facebook'], ['亚马逊', 'amazon'],
  ['性能最大化', 'performance max pmax p-max'], ['p-max', 'pmax performance max'],
  ['advantage', 'advantage+ advantage plus'],
  ['扩量', 'scaling scale'], ['加预算', 'increase budget'], ['优化', 'optimization audit'], ['日常排查', 'audit optimization'],
  ['报表', 'reporting report'], ['看数据', 'reporting analytics'],
  ['品牌词', 'brand keyword brand term'], ['防守', 'brand defense'],
];

function expandQuery(q) {
  const lower = q.toLowerCase();
  const exp = [];
  for (const [zh, en] of GLOSSARY) {
    if (lower.includes(zh.toLowerCase())) exp.push(en);
    else if (lower.includes(en.toLowerCase())) exp.push(zh);
    else {
      const ws = en.split(/\s+/);
      if (ws.length > 1 && ws.every(w => w.length > 2 && lower.includes(w.toLowerCase()))) exp.push(zh);
    }
  }
  return exp.length ? q + ' ' + exp.join(' ') : q;
}

// ---- 朴素 BM25-ish 检索 (token 命中数 + 字段权重 + 长度归一) ----
// 不引第三方依赖,用 stdlib 实现,够用就行
function tokenize(s) {
  const re = /[a-zA-Z0-9]+|[一-龥]+/g;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) if (m[0].length >= 2) out.push(m[0].toLowerCase());
  return out;
}

function retrieve(query, k = 8) {
  const expanded = expandQuery(query);
  const qTokens = tokenize(expanded);
  if (qTokens.length === 0) return [];

  const scored = [];
  for (const t of DATA.takeaways) {
    const titleTok = tokenize(t.title_zh);
    const sumTok = tokenize(t.summary_zh);
    const quoteTok = tokenize(t.quote_en || '');
    const topicTok = tokenize((t.topics || []).join(' '));

    let score = 0, hits = 0;
    for (const qt of qTokens) {
      const qlow = qt.toLowerCase();
      // 完整 token 匹配 + 子串匹配
      let h = 0;
      if (titleTok.some(x => x.includes(qlow) || qlow.includes(x))) h += 3;
      if (sumTok.some(x => x.includes(qlow) || qlow.includes(x))) h += 1.5;
      if (quoteTok.some(x => x.includes(qlow) || qlow.includes(x))) h += 1;
      if (topicTok.some(x => x.includes(qlow) || qlow.includes(x))) h += 0.8;
      if (h > 0) { score += h; hits += 1; }
    }
    if (hits === 0) continue;
    // 多 token 命中 → 放大 (BM25 思想,但简化)
    score *= 1 + 0.15 * Math.log(1 + hits);
    if (t.amazon_relevance === 'high') score += 0.5;
    scored.push({ kind: 'takeaway', item: t, score, hits });
  }
  for (const u of (DATA.official_updates || [])) {
    const titleTok = tokenize(u.title_zh);
    const sumTok = tokenize(u.summary_zh);
    const topicTok = tokenize((u.topics || []).join(' '));
    let score = 0, hits = 0;
    for (const qt of qTokens) {
      const qlow = qt.toLowerCase();
      let h = 0;
      if (titleTok.some(x => x.includes(qlow) || qlow.includes(x))) h += 3;
      if (sumTok.some(x => x.includes(qlow) || qlow.includes(x))) h += 1.5;
      if (topicTok.some(x => x.includes(qlow) || qlow.includes(x))) h += 0.8;
      if (h > 0) { score += h; hits += 1; }
    }
    if (hits === 0) continue;
    score *= 1 + 0.15 * Math.log(1 + hits);
    scored.push({ kind: 'official', item: u, score, hits });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ---- 平台意图检测 ----
function detectPlatform(q) {
  const lower = q.toLowerCase();
  if (/\bamazon\b|亚马逊|sp\b|sb\b|sd\b|sponsored product|listing/.test(lower)) return 'amazon';
  if (/\bmeta\b|facebook|脸书|advantage|fb ads/.test(lower)) return 'meta';
  if (/\bgoogle\b|谷歌|pmax|p-max|performance max|search ads|youtube ads|gads/.test(lower)) return 'google';
  return null;
}

// ---- 调 LLM ----
const SYSTEM_PROMPT = `你是 Grace 的 DTC 投放学习助手。Grace 主做 Amazon 引流,**没有** retargeting / cart abandoner / warm pool 概念,写策略时一律用 prospecting / Amazon BSR 自然流量承接 替代。

回答规则:
1. 只能基于"候选素材"里的事实,不允许凭训练数据补充。
2. 极简格式:tldr 一句核心答案(≤50 字);bullets 2-4 条判断/取舍/红线(每条 ≤35 字);amazon_tip 一句 Amazon 落地动作(≤40 字,不适用返回空串)。
3. **保真硬规则**:原文里的量化条件、双层结构、双条件(如 "高竞争 + 高 CPC 双条件"、"campaign 和 ad group 两层"、"预算 X 之上 vs 之下")**必须完整保留**,不许为字数把双条件砍成单条件。字数不够时,宁可少写一条 bullet,不许阉割语义。
4. bullets 之间必须信息互斥,禁止同一判断换措辞重复;宁可只出 2 条也不凑数。
5. 必须 cite takeaway_id(素材里的 id)。
6. 素材不足以回答 → tldr 直说 "语料里没覆盖",bullets 建议跳到哪个主题/博主继续看,warning 字段写清楚"哪部分未覆盖",不硬编。
7. 素材里有冲突观点 → 把冲突写进 bullets(如 "博主 A 说 X;博主 B 反对"),warning 字段也写"存在冲突",不选边。
8. 平台对齐:query 是 Amazon 上下文时,优先引用 amazon_relevance: high 的素材;跨平台借用要在 bullets 里注明 "原为 X 平台"。

输出严格 JSON,无 markdown 代码块包裹。schema:
{
  "tldr": "≤40 字核心答案",
  "bullets": ["≤25 字", "≤25 字", "≤25 字"],
  "amazon_tip": "≤35 字 Amazon 落地,或空串",
  "citations": ["takeaway_id_1", "takeaway_id_2"],
  "warning": null 或 "素材不足/冲突提示",
  "follow_up_topic": null 或 topic slug
}`;

function buildUserPrompt(question, candidates, platformIntent) {
  const lines = candidates.map((c, i) => {
    const it = c.item;
    if (c.kind === 'takeaway') {
      return `[${i + 1}] id=${it.id}  channel=${it.channel_slug}  topics=${(it.topics || []).join(',')}  amazon_relevance=${it.amazon_relevance}
  标题: ${it.title_zh}
  摘要: ${it.summary_zh}
  原话(en): ${(it.quote_en || '').slice(0, 240)}`;
    } else {
      return `[${i + 1}] id=${it.id}  source=official  publisher=${it.publisher}  platform=${it.platform}
  标题: ${it.title_zh}
  摘要: ${it.summary_zh}`;
    }
  }).join('\n\n');
  const platformHint = platformIntent
    ? `\n用户 query 提到了 ${platformIntent} 平台,优先用该平台素材;跨平台借鉴必须明说。`
    : '';
  return `问题: ${question}${platformHint}

候选素材 (${candidates.length} 条,按相关度排):
${lines}

请按 schema 输出 JSON。`;
}

async function callLLM(question, candidates, platformIntent) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(question, candidates, platformIntent) }],
  };
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': AUTH_TOKEN,
    'authorization': `Bearer ${AUTH_TOKEN}`,
  };
  const url = `${BASE_URL.replace(/\/$/, '')}/v1/messages`;
  const t0 = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const latency = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data.content?.[0]?.text || '';
  // 容错剥 ```json
  let jsonText = raw.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
  }
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch (e) {
    return { _raw: raw, _parse_error: e.message, latency_ms: latency };
  }
  return { ...parsed, latency_ms: latency };
}

// ---- HTTP server ----
function send(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, takeaways: DATA.takeaways.length });
  if (req.method !== 'POST' || !req.url.startsWith('/api/answer')) return send(res, 404, { error: 'not found' });

  let body = '';
  req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
  req.on('end', async () => {
    try {
      const { question } = JSON.parse(body || '{}');
      if (!question || typeof question !== 'string' || question.trim().length < 2) {
        return send(res, 400, { error: '问题太短了' });
      }
      const platformIntent = detectPlatform(question);
      const candidates = retrieve(question, 8);
      if (candidates.length === 0) {
        return send(res, 200, {
          answer_博主原话: '语料里没找到能回答这个问题的素材。',
          answer_Amazon落地: '建议换种说法,或直接搜博主名/具体术语。',
          citations: [],
          warning: '0 候选',
          follow_up_topic: null,
          _retrieved: 0,
          _platform: platformIntent,
        });
      }
      const llmOut = await callLLM(question, candidates, platformIntent);
      send(res, 200, {
        ...llmOut,
        _retrieved: candidates.length,
        _candidates: candidates.map(c => ({
          id: c.item.id, kind: c.kind, score: Number(c.score.toFixed(2)),
          channel: c.item.channel_slug || c.item.publisher,
          title: c.item.title_zh,
          video_id: c.item.video_id, timestamp: c.item.timestamp_seconds,
          official_url: c.item.official_url,
        })),
        _platform: platformIntent,
      });
    } catch (e) {
      console.error('!! answer error:', e.message);
      send(res, 500, { error: e.message });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`▶ answer-server: http://127.0.0.1:${PORT}/api/answer  (CORS: ${ALLOWED_ORIGIN})`);
  console.log(`  健康检查: curl http://127.0.0.1:${PORT}/health`);
});
