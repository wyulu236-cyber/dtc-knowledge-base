// assistant.js — 小助手 widget(retrieval-only)
// 原则: 不替你回答,只帮你找入口。
//   - 输入自然语言问题
//   - 用 fuse.js 检索 + intent keyword 加权
//   - surface 最相关的 5 条 takeaway + 1 个推荐主题入口
//   - 不调任何 LLM API,纯客户端

(function () {
  // ---- 自然语言意图 → topic slug 映射 + 加权词 ----
  // 用户输入命中关键词时,该 topic 的 takeaway 会被 boost
  const INTENT_MAP = [
    { keywords: ['搭建', '搭', '建', '架构', '结构', '怎么搭', 'campaign 怎么', '广告组', 'ad group', 'campaign structure'], topic: 'campaign-structure' },
    { keywords: ['创意', '素材', '视频', 'creative', 'hook', '钩子', '测素材', '广告创意', '测试创意', 'thumbnail', '主图'], topic: 'creative-testing' },
    { keywords: ['文案', '标题', 'headline', 'copy', 'CTA', '广告词'], topic: 'copy' },
    { keywords: ['出价', '竞价', 'bid', 'cpc', 'bidding', 'tcpa', 'troas', '智能出价', 'manual'], topic: 'bidding' },
    { keywords: ['扩量', 'scaling', 'scale', '加预算', '怎么扩', '增长', '天花板'], topic: 'scaling' },
    { keywords: ['归因', 'attribution', '7 天', '7天', '14 天', '14天', '归因窗口', 'view through', 'click through'], topic: 'attribution' },
    { keywords: ['否定词', 'negative', 'negative keyword', '屏蔽词', 'search term', '搜索词报告'], topic: 'negative-keywords' },
    { keywords: ['受众', 'audience', 'lookalike', 'lal', '人群', '兴趣', 'interest'], topic: 'audience' },
    { keywords: ['报表', 'reporting', '看数据', '指标', '怎么看', '数据怎么读'], topic: 'reporting' },
    { keywords: ['落地页', 'landing page', 'lp', '页面', 'cro', '转化率', 'conversion rate'], topic: 'landing-page' },
    { keywords: ['预算', 'budget', '预算分配', 'cbo', 'abo', 'daily budget'], topic: 'budget' },
    { keywords: ['优化', 'optimization', '怎么优化', '日常操作', 'optimize', '调整', 'audit'], topic: 'optimization' },
    { keywords: ['数据分析', 'analytics', 'ga4', '埋点'], topic: 'analytics' },
    { keywords: ['品牌', 'brand', '品牌词', '防守'], topic: 'brand' },
    { keywords: ['p-max', 'pmax', 'performance max', 'p max'], topic: 'P-Max' },
    { keywords: ['advantage', 'advantage+', 'advantage plus'], topic: 'Advantage+' },
    { keywords: ['垂类', 'niche', 'b2b', '细分'], topic: 'niche' },
  ];

  // ---- 常见示例问题(空状态展示) ----
  const SAMPLE_QUESTIONS = [
    'campaign 怎么搭建',
    '怎么测 creative 素材',
    '怎么扩量不烧穿人群',
    '小预算怎么投',
    'search term 报告怎么看',
    '7 天还是 14 天归因',
  ];

  // ---- DOM 注入 ----
  const fab = document.createElement('button');
  fab.id = 'assistant-fab';
  fab.className = 'assistant-fab';
  fab.title = '问小助手';
  fab.innerHTML = '<span class="assistant-fab__drop">💧</span><span class="assistant-fab__label">小助手</span>';

  const panel = document.createElement('aside');
  panel.id = 'assistant-panel';
  panel.className = 'assistant-panel';
  panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML = `
    <div class="assistant-panel__head">
      <div class="assistant-panel__title">
        <span class="assistant-fab__drop">💧</span>
        <div>
          <strong>小助手</strong>
        </div>
      </div>
      <button class="assistant-panel__close" aria-label="关闭">✕</button>
    </div>
    <form class="assistant-panel__input" id="assistant-form">
      <input type="text" id="assistant-q" placeholder="比如:campaign 怎么搭建" autocomplete="off" maxlength="80">
      <button type="submit" aria-label="搜索">🔍</button>
    </form>
    <div class="assistant-panel__samples" id="assistant-samples">
      <p class="assistant-panel__sample-label">试试问:</p>
      ${SAMPLE_QUESTIONS.map(q => `<button type="button" class="assistant-sample" data-q="${q}">${q}</button>`).join('')}
      <p class="assistant-panel__manifesto">
        <strong>怎么用:</strong> 输入问题 → AI 基于 ${'<span id=\"assistant-tcount\">·</span>'} 条 takeaway + 官方动态合成回答 + 列出引用卡片。<br>
        <span class="assistant-panel__manifesto-note">AI 可能合成偏,卡片点 ▶ 跳 YouTube / ↗ 跳官方源自己核对,信任责任在你。</span>
      </p>
    </div>
    <div class="assistant-panel__results" id="assistant-results" hidden></div>
  `;
  document.body.appendChild(fab);
  document.body.appendChild(panel);

  // ---- 状态 ----
  let opened = false;
  function open() {
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    fab.classList.add('is-hidden');
    setTimeout(() => document.getElementById('assistant-q').focus(), 200);
    opened = true;
  }
  function close() {
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    fab.classList.remove('is-hidden');
    opened = false;
  }
  fab.addEventListener('click', open);
  panel.querySelector('.assistant-panel__close').addEventListener('click', close);

  // ESC 关闭
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && opened) close();
  });

  // 主页 / PLAYBOOK 末尾的 CTA 按钮(事件委托,因为是动态渲染)
  document.addEventListener('click', e => {
    if (e.target && (e.target.id === 'open-assistant-cta' || e.target.id === 'open-assistant-foot')) {
      open();
    }
    // 示例问题点击
    if (e.target && e.target.classList && e.target.classList.contains('assistant-sample')) {
      const q = e.target.dataset.q;
      const input = document.getElementById('assistant-q');
      if (input) {
        input.value = q;
        runQuery(q);
      }
    }
  });

  // ---- 表单提交 ----
  document.getElementById('assistant-form').addEventListener('submit', e => {
    e.preventDefault();
    const q = document.getElementById('assistant-q').value.trim();
    if (q.length < 2) return;
    runQuery(q);
  });

  // ---- 中英术语词典 (Phase 1: 修 retrieval 跨语言断层) ----
  // Grace 用中文问 "exact match 和 phrase match" 时,fuse 抓不到中文 takeaway 标题
  // "Match Type 已不再需要分 ad group"。这里把 query 命中的术语自动扩成中英双语再 fuse。
  // 维护规则: 一条术语的中文+英文都列上,顺序无关,大小写不敏感。
  const BILINGUAL_GLOSSARY = [
    // 匹配类型
    ['精确匹配', 'exact match'],
    ['短语匹配', 'phrase match'],
    ['广泛匹配', 'broad match'],
    ['匹配类型', 'match type'],
    ['同义词匹配', 'close variant'],
    ['近似词', 'close variant'],
    // 关键词
    ['关键词', 'keyword'],
    ['否定词', 'negative keyword'],
    ['负关键词', 'negative keyword'],
    ['屏蔽词', 'negative keyword'],
    ['搜索词', 'search term'],
    ['搜索词报告', 'search term report'],
    // 广告结构
    ['广告组', 'ad group'],
    ['广告系列', 'campaign'],
    ['资产组', 'asset group'],
    // 竞价 / 互相争抢
    ['相互竞价', 'cannibalization compete'],
    ['自相残杀', 'cannibalization self-cannibalization'],
    ['互相争抢', 'cannibalization compete overlap'],
    ['关键词重叠', 'keyword overlap cannibalization'],
    // 出价
    ['出价', 'bid bidding'],
    ['手动出价', 'manual cpc'],
    ['智能出价', 'smart bidding'],
    ['目标 cpa', 'tcpa target cpa'],
    ['目标 roas', 'troas target roas'],
    // 创意 / 素材
    ['创意', 'creative'],
    ['素材', 'creative'],
    ['钩子', 'hook hook rate'],
    ['前 3 秒', 'hook first 3 seconds'],
    ['缩略图', 'thumbnail'],
    ['标题', 'headline title'],
    ['文案', 'copy'],
    // 受众
    ['受众', 'audience'],
    ['类似受众', 'lookalike lal'],
    ['受众饱和', 'audience saturation fatigue'],
    ['再营销', 'remarketing retargeting'],
    ['重定向', 'retargeting'],
    ['冷启动', 'cold start prospecting new account'],
    // 归因 / 报表
    ['归因', 'attribution'],
    ['归因窗口', 'attribution window'],
    ['7 天点击', '7 day click'],
    ['14 天点击', '14 day click'],
    ['view through', 'view-through'],
    // 落地页 / 转化
    ['落地页', 'landing page lp'],
    ['转化率', 'conversion rate cvr'],
    ['转化', 'conversion'],
    ['漏斗', 'funnel'],
    // 平台
    ['谷歌', 'google google ads'],
    ['脸书', 'meta facebook'],
    ['亚马逊', 'amazon'],
    ['性能最大化', 'performance max pmax p-max'],
    ['p-max', 'pmax performance max'],
    ['advantage', 'advantage+ advantage plus'],
    // 投放动作
    ['扩量', 'scaling scale'],
    ['加预算', 'increase budget'],
    ['优化', 'optimization audit'],
    ['日常排查', 'audit optimization'],
    // 报表
    ['报表', 'reporting report'],
    ['看数据', 'reporting analytics'],
    // 品牌
    ['品牌词', 'brand keyword brand term'],
    ['防守', 'brand defense'],
  ];

  function expandQuery(q) {
    const lower = q.toLowerCase();
    const expansions = [];
    for (const [zh, en] of BILINGUAL_GLOSSARY) {
      if (lower.includes(zh.toLowerCase())) expansions.push(en);
      else if (lower.includes(en.toLowerCase())) expansions.push(zh);
      else {
        // 英文术语词组单词命中(例如 query 是 "exact match" 也要触发 "精确匹配")
        const enWords = en.split(/\s+/);
        if (enWords.length > 1 && enWords.every(w => w.length > 2 && lower.includes(w.toLowerCase()))) {
          expansions.push(zh);
        }
      }
    }
    if (expansions.length === 0) return q;
    return q + ' ' + expansions.join(' ');
  }

  function detectPlatformIntent(q) {
    const lower = q.toLowerCase();
    if (/\bamazon\b|亚马逊|sp\b|sb\b|sd\b|sponsored product|listing/.test(lower)) return 'amazon';
    if (/\bmeta\b|facebook|脸书|advantage|fb ads/.test(lower)) return 'meta';
    if (/\bgoogle\b|谷歌|pmax|p-max|performance max|search ads|youtube ads|gads/.test(lower)) return 'google';
    return null;
  }

  // ---- 检索逻辑 ----
  function detectIntent(q) {
    const lower = q.toLowerCase();
    const hits = [];
    for (const intent of INTENT_MAP) {
      const matched = intent.keywords.filter(k => lower.includes(k.toLowerCase()));
      if (matched.length > 0) hits.push({ topic: intent.topic, score: matched.length });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  function fmtSec(sec) {
    sec = sec | 0;
    const h = (sec / 3600) | 0, m = ((sec % 3600) / 60) | 0, s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---- AI 答题(Phase 2) — 走 localhost:8081/api/answer 公司 relay ----
  // 失败 / server 没起 / 超时,自动降级到 Phase 1 retrieval-only 卡片
  const ANSWER_API = (window.ANSWER_API_BASE || 'http://127.0.0.1:8081') + '/api/answer';
  const ANSWER_TIMEOUT_MS = 25000;

  async function callAnswerAPI(question) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ANSWER_TIMEOUT_MS);
    try {
      const res = await fetch(ANSWER_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`API ${res.status}: ${txt.slice(0, 200)}`);
      }
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  }

  function renderAnswer(data, question) {
    const cands = data._candidates || [];
    const cited = new Set(data.citations || []);
    const citedCands = cands.filter(c => cited.has(c.id));
    const otherCands = cands.filter(c => !cited.has(c.id)).slice(0, 3);
    const platformBadge = data._platform ? `<span class="assistant-platform-tag">${data._platform === 'amazon' ? 'Amazon' : (data._platform === 'meta' ? 'Meta' : 'Google')}</span>` : '';
    const warningHTML = data.warning ? `<p class="assistant-weak-warn">⚠️ ${escape(data.warning)}</p>` : '';
    const followUpTopic = data.follow_up_topic && window.DATA.topics.find(t => t.slug === data.follow_up_topic);
    const followHTML = followUpTopic ? `
      <a class="assistant-answer__followup" href="#/topics/${followUpTopic.slug}">→ 系统看「${escape(followUpTopic.label_zh)}」(${followUpTopic.takeaway_count} 条)</a>` : '';

    // 新格式: tldr + bullets + amazon_tip
    const hasNewFormat = data.tldr && Array.isArray(data.bullets) && data.bullets.length > 0;
    let coreHTML;
    if (hasNewFormat) {
      coreHTML = `
        <p class="assistant-answer__tldr">${escape(data.tldr)}</p>
        <ul class="assistant-answer__bullets">
          ${data.bullets.map(b => `<li>${escape(b)}</li>`).join('')}
        </ul>
        ${data.amazon_tip ? `<p class="assistant-answer__amazon">🛒 Amazon:${escape(data.amazon_tip)}</p>` : ''}
      `;
    } else {
      // 兼容旧字段 (server 未重启时)
      coreHTML = `
        ${data['answer_博主原话'] ? `<p class="assistant-answer__tldr">${escape(data['answer_博主原话'])}</p>` : ''}
        ${data['answer_Amazon落地'] ? `<p class="assistant-answer__amazon">🛒 Amazon:${escape(data['answer_Amazon落地'])}</p>` : ''}
      `;
    }

    return `
      <div class="assistant-answer">
        <div class="assistant-answer__head">
          <span class="assistant-answer__badge">AI</span>
          ${platformBadge}
          <span class="assistant-answer__meta">基于 ${data._retrieved} 条 · ${data.latency_ms ? Math.round(data.latency_ms / 100) / 10 + 's' : ''}</span>
        </div>
        ${coreHTML}
        ${warningHTML}
        ${citedCands.length > 0 ? `
          <details class="assistant-answer__cites" open>
            <summary>引用 ${citedCands.length} 条 · 点 ▶ 核对原视频</summary>
            <div class="assistant-cards">
              ${citedCands.map((c, i) => renderCandidateMini(c, i + 1)).join('')}
            </div>
          </details>` : ''}
        ${otherCands.length > 0 ? `
          <details class="assistant-answer__more">
            <summary>相关 ${otherCands.length} 条 ▾</summary>
            <div class="assistant-cards">
              ${otherCands.map((c, i) => renderCandidateMini(c, citedCands.length + i + 1)).join('')}
            </div>
          </details>` : ''}
        ${followHTML}
        <p class="assistant-answer__foot">AI 合成可能偏,点卡片跳原视频/官方源核对。</p>
        <button class="assistant-back" id="assistant-back">← 重新提问</button>
      </div>
    `;
  }

  function renderCandidateMini(c, index) {
    if (c.kind === 'official') {
      return `
        <article class="assistant-card assistant-card--official">
          <div class="assistant-card__head">
            <span class="assistant-card__num">${index}</span>
            <span class="assistant-card__source-tag">官方</span>
            <span class="assistant-card__channel">${escape(c.channel || '')}</span>
            ${c.official_url ? `<a class="assistant-card__time" href="${escape(c.official_url)}" target="_blank" rel="noopener">↗ 官方源</a>` : ''}
          </div>
          <h4 class="assistant-card__title">${escape(c.title)}</h4>
        </article>`;
    }
    const ch = window.DATA.channels.find(x => x.slug === c.channel);
    return `
      <article class="assistant-card">
        <div class="assistant-card__head">
          <span class="assistant-card__num">${index}</span>
          <span class="assistant-card__channel">${ch ? escape(ch.name) : escape(c.channel || '')}</span>
          ${c.video_id ? `<a class="assistant-card__time" href="#/videos/${c.video_id}?t=${c.timestamp || 0}" onclick="document.getElementById('assistant-panel').classList.remove('is-open');document.getElementById('assistant-fab').classList.remove('is-hidden');">▶ ${fmtSec(c.timestamp || 0)}</a>` : ''}
        </div>
        <h4 class="assistant-card__title">${escape(c.title)}</h4>
      </article>`;
  }

  function runQuery(q) {
    const $samples = document.getElementById('assistant-samples');
    const $results = document.getElementById('assistant-results');
    $samples.hidden = true;
    $results.hidden = false;
    $results.innerHTML = `<div class="assistant-loading">正在从 239 条 takeaway 里提炼…</div>`;

    if (!window.DATA || !window.FUSE) {
      $results.innerHTML = `<div class="assistant-empty">数据还没加载好,稍等几秒再试。</div>`;
      return;
    }

    // 先尝试 LLM 答题, 失败降级到 Phase 1 retrieval
    callAnswerAPI(q).then(data => {
      if (data && (data.tldr || data['answer_博主原话'] || data['answer_Amazon落地'])) {
        $results.innerHTML = renderAnswer(data, q);
        document.addEventListener('click', backHandler, { once: true });
      } else if (data && data._raw) {
        // LLM 返回了文本但 JSON 解析失败 — 直接展示原文 + fallback retrieval
        $results.innerHTML = `
          <div class="assistant-answer">
            <div class="assistant-answer__head">
              <span class="assistant-answer__badge">🤖 AI 答案 (原文)</span>
            </div>
            <p class="assistant-answer__body" style="white-space:pre-wrap;">${escape(data._raw)}</p>
            <button class="assistant-back" id="assistant-back">← 重新提问</button>
          </div>`;
        document.addEventListener('click', backHandler, { once: true });
      } else {
        runQueryRetrieval(q);
      }
    }).catch(err => {
      console.warn('[assistant] LLM 失败,降级到 retrieval:', err.message);
      $results.innerHTML = `
        <div class="assistant-fallback-warn">
          AI 答题层连不上 (${escape(err.message.slice(0, 80))}),降级展示卡片让你自己读。<br>
          <span style="font-size:11px;opacity:0.7;">检查: 是否跑了 <code>./site/start.sh</code> 启动 answer-server?</span>
        </div>`;
      // 100ms 后接 retrieval
      setTimeout(() => runQueryRetrieval(q, true), 100);
    });
  }

  // Phase 1 retrieval (降级路径,保留作为 LLM 失败时的兜底)
  function runQueryRetrieval(q, isFallback) {
    const $results = document.getElementById('assistant-results');
    if (!isFallback) $results.innerHTML = `<div class="assistant-loading">检索中…</div>`;

    // 1. 关键词意图 → boost topic
    const intentHits = detectIntent(q);
    const boostTopics = new Set(intentHits.map(h => h.topic));
    const platformIntent = detectPlatformIntent(q);

    // 2. fuse 模糊搜索 — 双语扩展 + token 拆分(单长串 fuzzy 对中英混合 query 几乎必然 0 命中)
    const expandedQ = expandQuery(q);
    // 抽出所有 ASCII 词和中文连续段; 过滤太短的 (中英都 >= 3 字符,避免 "和/的/是" 这类停用)
    const tokenRe = /[a-zA-Z0-9]+|[一-龥]+/g;
    const tokens = (expandedQ.match(tokenRe) || []).filter(t => t.length >= 3);
    // 多次搜索 + 按 item id 合并,留最佳 fuse score + 命中 token 数
    const merged = new Map();
    const searchTerms = [expandedQ, ...new Set(tokens)];
    for (const term of searchTerms) {
      const hits = window.FUSE.search(term);
      for (const r of hits) {
        const key = (r.item.id || r.item.slug || r.item.title);
        if (!key) continue;
        const ex = merged.get(key);
        if (!ex) merged.set(key, { item: r.item, score: r.score, hitCount: 1 });
        else { ex.hitCount += 1; if (ex.score > r.score) ex.score = r.score; }
      }
    }
    const fuseResults = [...merged.values()].sort((a, b) => a.score - b.score).slice(0, 50);

    // 3. 取 takeaway + official 两类,按 (相关度 + intent boost + platform boost) 排
    //    注意: 不给 official 任何 source 加权 — 中性混排,信任责任还给用户
    const scored = [];
    for (const r of fuseResults) {
      if (r.item.type === 'takeaway') {
        const take = window.DATA.takeaways.find(t => t.id === r.item.id);
        if (!take) continue;
        let score = -r.score;
        if (r.hitCount > 1) score += 0.15 * (r.hitCount - 1); // 多 token 命中加权
        const boostedTopics = take.topics.filter(tp => boostTopics.has(tp));
        if (boostedTopics.length > 0) score += 0.5 * boostedTopics.length;
        if (take.amazon_relevance === 'high') score += 0.15;
        // 平台对齐:query 显式提到平台时,匹配的博主 +boost,不匹配 -penalty
        if (platformIntent) {
          const ch = window.DATA.channels.find(c => c.slug === take.channel_slug);
          if (ch && ch.platform === platformIntent) score += 0.4;
          else if (ch && ch.platform && ch.platform !== platformIntent) score -= 0.2;
        }
        scored.push({ kind: 'takeaway', item: take, score, fuseScore: r.score });
      } else if (r.item.type === 'official') {
        const upd = (window.DATA.official_updates || []).find(u => u.id === r.item.id);
        if (!upd) continue;
        let score = -r.score;
        if (r.hitCount > 1) score += 0.15 * (r.hitCount - 1);
        const boostedTopics = (upd.topics || []).filter(tp => boostTopics.has(tp));
        if (boostedTopics.length > 0) score += 0.5 * boostedTopics.length;
        // 平台对齐
        if (platformIntent && upd.platform === platformIntent) score += 0.4;
        else if (platformIntent && upd.platform && upd.platform !== platformIntent) score -= 0.2;
        scored.push({ kind: 'official', item: upd, score, fuseScore: r.score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const top5 = scored.slice(0, 5);

    // 4. 诚实判定:top 命中的 fuse score 越大越差 (fuse 0 = 完美, > 0.4 = 弱)
    const bestFuseScore = top5.length > 0 ? top5[0].fuseScore : 1;
    const confidence = bestFuseScore < 0.25 ? 'strong' : (bestFuseScore < 0.45 ? 'medium' : 'weak');

    // 5. 推荐主题入口
    const recommendedTopic = intentHits[0] && window.DATA.topics.find(t => t.slug === intentHits[0].topic);

    // 6. 渲染
    if (top5.length === 0 && !recommendedTopic) {
      $results.innerHTML = `
        <div class="assistant-empty">
          <strong>语料里没找到匹配。</strong><br>
          239 条 takeaway + 13 条官方动态都跑了一遍,没命中。换种说法试试:<br>
          · 用具体术语:<em>"exact match"</em> 而不是 <em>"匹配类型怎么搞"</em><br>
          · 讲场景:<em>"ROAS 突然崩了怎么排查"</em><br>
          · 直接搜博主名/视频关键词
        </div>
        <button class="assistant-back" id="assistant-back">← 返回示例问题</button>
      `;
    } else if (top5.length === 0 && recommendedTopic) {
      $results.innerHTML = `
        <div class="assistant-empty">
          <strong>没找到具体 takeaway,但你可能想看这个主题:</strong>
        </div>
        <div class="assistant-recommend">
          <a class="btn btn--ghost" href="#/topics/${recommendedTopic.slug}">📂 跳到「${escape(recommendedTopic.label_zh)}」主题 (${recommendedTopic.takeaway_count} 条)</a>
        </div>
        <button class="assistant-back" id="assistant-back">← 重新提问</button>
      `;
    } else {
      const officialCount = top5.filter(x => x.kind === 'official').length;
      const takeawayCount = top5.filter(x => x.kind === 'takeaway').length;
      const confLabel = confidence === 'strong' ? '' : (confidence === 'medium' ? '<span class="assistant-conf assistant-conf--medium">中等匹配</span>' : '<span class="assistant-conf assistant-conf--weak">弱匹配 · 仅供模糊参考</span>');
      const platformBadge = platformIntent ? `<span class="assistant-platform-tag">${platformIntent === 'amazon' ? 'Amazon' : (platformIntent === 'meta' ? 'Meta' : 'Google')} 上下文</span>` : '';
      $results.innerHTML = `
        <div class="assistant-results__head">
          <strong>${top5.length}</strong> 条最相关 ${officialCount > 0 ? `<span class="assistant-results__mix">(${takeawayCount} 条博主 · ${officialCount} 条官方)</span>` : ''}
          ${platformBadge}
          ${confLabel}
          ${recommendedTopic ? `<span class="assistant-results__hint">命中主题: <a href="#/topics/${recommendedTopic.slug}">${escape(recommendedTopic.label_zh)}</a></span>` : ''}
        </div>
        ${confidence === 'weak' ? `<p class="assistant-weak-warn">语料里没找到强匹配,以下卡片是模糊关联,可能跟你问的不完全是一回事。建议跳到原视频/官方源核对。</p>` : ''}
        <div class="assistant-cards">
          ${top5.map((entry, i) => entry.kind === 'takeaway' ? renderTakeawayMini(entry.item, i + 1) : renderOfficialMini(entry.item, i + 1)).join('')}
        </div>
        ${recommendedTopic ? `
          <div class="assistant-recommend">
            <p class="assistant-recommend__label">想系统看这个主题?</p>
            <a class="btn btn--ghost" href="#/topics/${recommendedTopic.slug}">📂 跳到「${escape(recommendedTopic.label_zh)}」主题 (${recommendedTopic.takeaway_count} 条)</a>
          </div>
        ` : ''}
        <button class="assistant-back" id="assistant-back">← 重新提问</button>
      `;
    }

    document.addEventListener('click', backHandler, { once: true });
  }

  function backHandler(e) {
    if (e.target && e.target.id === 'assistant-back') {
      const $samples = document.getElementById('assistant-samples');
      const $results = document.getElementById('assistant-results');
      const $q = document.getElementById('assistant-q');
      $samples.hidden = false;
      $results.hidden = true;
      $results.innerHTML = '';
      if ($q) { $q.value = ''; $q.focus(); }
    }
  }

  function renderTakeawayMini(t, index) {
    const ch = window.DATA.channels.find(c => c.slug === t.channel_slug);
    return `
      <article class="assistant-card">
        <div class="assistant-card__head">
          <span class="assistant-card__num">${index}</span>
          <span class="assistant-card__channel">${ch ? escape(ch.name) : escape(t.channel_slug)}</span>
          <a class="assistant-card__time" href="#/videos/${t.video_id}?t=${t.timestamp_seconds}" onclick="document.getElementById('assistant-panel').classList.remove('is-open');document.getElementById('assistant-fab').classList.remove('is-hidden');">▶ ${fmtSec(t.timestamp_seconds)}</a>
        </div>
        <h4 class="assistant-card__title">${escape(t.title_zh)}</h4>
        <p class="assistant-card__hint">${escape(t.summary_zh.slice(0, 100))}${t.summary_zh.length > 100 ? '…' : ''}</p>
      </article>
    `;
  }

  // ---- official_update mini 卡片 ----
  // 中性 source 标签 (无颜色按 impact 区分),只标 publisher + verified_on
  // 信任责任在用户:点击跳官方源核对
  function monthsAgoMini(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  }
  function renderOfficialMini(u, index) {
    const platformLabel = u.platform === 'google' ? 'Google Ads' : (u.platform === 'meta' ? 'Meta Ads' : escape(u.platform));
    const verifiedAge = monthsAgoMini(u.verified_on);
    const isStale = verifiedAge !== null && verifiedAge >= 6;
    const verifiedLabel = u.verified_on ? `核对于 ${escape(u.verified_on)}` : '未核对';
    const actionable = u.amazon_actionable === true;
    return `
      <article class="assistant-card assistant-card--official${isStale ? ' is-stale' : ''}">
        <div class="assistant-card__head">
          <span class="assistant-card__num">${index}</span>
          <span class="assistant-card__source-tag">官方</span>
          <span class="assistant-card__channel">${platformLabel} · ${escape(u.publisher)}</span>
          ${u.official_url ? `<a class="assistant-card__time" href="${escape(u.official_url)}" target="_blank" rel="noopener">↗ 官方源</a>` : ''}
        </div>
        <h4 class="assistant-card__title">${escape(u.title_zh)}</h4>
        <p class="assistant-card__hint">${escape(u.summary_zh.slice(0, 100))}${u.summary_zh.length > 100 ? '…' : ''}</p>
        <div class="assistant-card__foot">
          <span class="assistant-card__amazon-mark">${actionable ? '🎯 Amazon 可动手' : 'ℹ️ 上下文背景'}</span>
          <span class="assistant-card__verified${isStale ? ' is-stale' : ''}">${verifiedLabel}${isStale ? ' · 可能过期' : ''}</span>
        </div>
      </article>
    `;
  }

  // ---- 数据就绪后填充计数 ----
  function fillCount() {
    const el = document.getElementById('assistant-tcount');
    if (el && window.DATA) el.textContent = window.DATA.takeaways.length;
  }
  if (window.DATA) fillCount();
  else {
    const tick = setInterval(() => {
      if (window.DATA) { fillCount(); clearInterval(tick); }
    }, 200);
  }
})();
