// app.js — 单页路由 + 渲染。无依赖 (除 fuse.js cdn)。
// 路由 (hash):
//   #/                    主页
//   #/topics/             所有主题列表
//   #/topics/<slug>        主题详情
//   #/channels/            所有博主列表
//   #/channels/<slug>      博主详情
//   #/videos/<id>          视频详情
//   #/search?q=xxx         搜索结果
//   #/about                关于

(async function () {
  const $app = document.getElementById('app');
  const $nav = document.querySelectorAll('[data-nav]');
  const $search = document.getElementById('search-box');
  const $stats = document.getElementById('meta-stats');

  // ---- 加载数据 ----
  let data;
  try {
    const r = await fetch('assets/data.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (e) {
    $app.innerHTML = `<div class="empty">
      <h2>数据未生成</h2>
      <p>请先按顺序跑完 <code>scripts/01 → 02 → 03 → 04</code>,然后刷新页面。</p>
      <p style="color:#999;font-size:12px">${escapeHtml(e.message)}</p>
    </div>`;
    return;
  }
  window.DATA = data;
  window.FUSE = window.buildFuse(data);
  $stats.textContent = `${data.takeaways.length} takeaway · ${data.channels.length} 博主 · ${data.videos.length} 视频`;

  // ---- 索引 ----
  const byVideoId = new Map(data.videos.map(v => [v.id, v]));
  const byChannelSlug = new Map(data.channels.map(c => [c.slug, c]));
  const byTopicSlug = new Map(data.topics.map(t => [t.slug, t]));
  const takeawayById = new Map(data.takeaways.map(t => [t.id, t]));

  // ---- 工具 ----
  function fmtSec(sec) {
    sec = sec | 0;
    const h = (sec / 3600) | 0, m = ((sec % 3600) / 60) | 0, s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function platformChip(p) {
    const cls = p === 'Meta' ? 'chip--platform-meta' : (p === 'Google' ? 'chip--platform-google' : '');
    return `<span class="chip ${cls}">${escapeHtml(p)}</span>`;
  }
  function relChip(r) {
    const labels = { high: 'Amazon✓ 高相关', medium: 'Amazon〜 中', low: 'Amazon✗ 低', none: '不相关' };
    return `<span class="chip chip--rel-${r}">${escapeHtml(labels[r] || r)}</span>`;
  }
  function topicChips(topics, activeSlug) {
    return topics.map(s => {
      const m = byTopicSlug.get(s);
      const label = m ? m.label_zh : s;
      const cls = s === activeSlug ? 'chip chip--accent' : 'chip';
      return `<a href="#/topics/${s}" class="${cls}">${escapeHtml(label)}</a>`;
    }).join('');
  }
  function ytEmbed(vid, startSec) {
    return `https://www.youtube.com/embed/${vid}?start=${startSec | 0}&rel=0&modestbranding=1`;
  }
  function ytWatch(vid, startSec) {
    return `https://www.youtube.com/watch?v=${vid}${startSec ? `&t=${startSec | 0}s` : ''}`;
  }

  // ---- 拆 summary: "DTC 主体" + "Amazon 落地" ----
  // 大部分 takeaway 的 summary_zh 末尾会有 "Amazon 启示/落地/类比/同理迁移/同构问题/等价做法/SP/SD/SB/A9 ..."
  // 分开渲染让卡片信息分层
  function splitSummary(s) {
    if (!s) return { main: '', amazon: '' };
    // 找最早出现的 "Amazon" 段触发点
    const triggers = [
      // 高精度: 显式 Amazon 启示/落地/类比/同理/同构/投手/卖家 (冒号可选,松绑)
      /(?:^|[。\.\s])(Amazon\s*(?:启示|落地|类比|同理|同构|投手|卖家))/,
      // 高精度: Amazon SP/SB/SD/A9 / Sponsored (带或不带 "上")
      /(?:^|[。\.\s])(Amazon\s*(?:上\s*)?(?:SP|SB|SD|A9|Sponsored))/,
      // "同理迁移到 Amazon"
      /(?:^|[。\.])(\s*同理迁移到\s*Amazon)/,
      // "Amazon (xxx) 同构/类比/可复刻/等价/完全适用/类似/完全对应"
      /(?:^|[。\.])(\s*Amazon\s*[^,。]{0,40}(?:同构|类比|可复刻|完全可复刻|等价|完全适用|完全相同|类似|完全对应))/,
      // "对应 Amazon" / "对 Amazon:" / "转 Amazon:"
      /(?:^|[。\.])(\s*(?:对应|对|转|给)\s*Amazon[\s:：])/,
      // "Amazon listing" / "Amazon Listing" / "Amazon 平台" (落地常见说法)
      /(?:^|[。\.\s])(Amazon\s*(?:[Ll]isting|平台))/,
      // 通用兜底: 句号/句首 + Amazon + 常见过渡词 (同样/上同理/上同样/上对应/站内/投放/端口?/侧/没有)
      /(?:^|[。\.])(\s*Amazon\s*(?:同样|上\s*同理|上\s*同样|上\s*对应|上\s*没有|站内|投放|端口?|侧|没有))/,
      // 通用兜底: 句号/句首 + Amazon + "上" 或 "投手" + 任意 (跨过缺少冒号的情况)
      /(?:^|[。\.])(\s*Amazon\s*(?:上|投手|卖家)\s*[^,。]{0,5}(?:同|对应|的|用|要|没|有|拿|做|端|按|启))/,
    ];
    let best = -1;
    for (const re of triggers) {
      const m = s.match(re);
      if (m && m.index !== undefined) {
        // m.index 是触发段开头(可能是 "。"),要往前对齐到 main 结束
        const startOfAmazon = m.index + (m[0].length - m[1].length);
        if (best === -1 || startOfAmazon < best) best = startOfAmazon;
      }
    }
    if (best > 0) {
      let main = s.slice(0, best).trim();
      let amazon = s.slice(best).trim();
      // 去掉 main 末尾可能残留的标点空格
      main = main.replace(/[,,]$/, '。');
      return { main, amazon };
    }
    return { main: s, amazon: '' };
  }

  // ---- 渲染: takeaway 卡片 ----
  function renderTakeawayCard(t, opts = {}) {
    const ch = byChannelSlug.get(t.channel_slug);
    const v = byVideoId.get(t.video_id);

    // 优先渲染新版:tldr + bullets + amazon_tip;原 summary_zh + quote_en 折叠到"完整写法"
    const hasNewFormat = t.tldr && Array.isArray(t.bullets) && t.bullets.length > 0;
    let body;
    if (hasNewFormat) {
      body = `<div class="takeaway__tldr"><span class="takeaway__tldr-label">🎯</span><p>${escapeHtml(t.tldr)}</p></div>
      <ul class="takeaway__bullets">
        ${t.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}
      </ul>
      ${t.amazon_tip ? `<div class="takeaway__amazon">
        <span class="takeaway__amazon-label">🛒 Amazon 落地</span>
        <p>${escapeHtml(t.amazon_tip)}</p>
      </div>` : ''}
      ${(t.summary_zh || t.quote_en) ? `<details class="takeaway__detail-toggle">
        <summary>展开完整写法</summary>
        ${t.summary_zh ? `<p class="takeaway__full-summary">${escapeHtml(t.summary_zh)}</p>` : ''}
        ${t.quote_en ? `<blockquote class="takeaway__quote">"${escapeHtml(t.quote_en)}"</blockquote>` : ''}
      </details>` : ''}`;
    } else {
      // 旧版兜底(还没被 rewrite 过的条目)
      const { main, amazon } = splitSummary(t.summary_zh);
      body = `<p class="takeaway__summary">${escapeHtml(main)}</p>
      ${amazon ? `<div class="takeaway__amazon">
        <span class="takeaway__amazon-label">🛒 Amazon 落地</span>
        <p>${escapeHtml(amazon.replace(/^(Amazon|amazon)\s*(启示|落地|类比)[:：]\s*/, ''))}</p>
      </div>` : ''}
      ${t.quote_en ? `<details class="takeaway__quote-wrap">
        <summary>📖 看英文原话</summary>
        <blockquote class="takeaway__quote">"${escapeHtml(t.quote_en)}"</blockquote>
      </details>` : ''}`;
    }

    return `<article class="takeaway">
      <div class="takeaway__head">
        <span class="takeaway__channel">
          <a href="#/channels/${t.channel_slug}">${escapeHtml(ch ? ch.name : t.channel_slug)}</a>
          ${ch ? platformChip(ch.platform) : ''}
        </span>
        <a class="takeaway__time" href="#/videos/${t.video_id}?t=${t.timestamp_seconds}">▶ ${fmtSec(t.timestamp_seconds)}</a>
      </div>
      <h3 class="takeaway__title">${escapeHtml(t.title_zh)}</h3>
      ${body}
      <div class="takeaway__foot">
        <div class="chip-row">${topicChips(t.topics, opts.topicSlug)}</div>
        ${relChip(t.amazon_relevance)}
      </div>
      ${v ? `<div class="card__meta"><span>📺 <a href="#/videos/${v.id}">${escapeHtml(v.title.slice(0, 70))}${v.title.length > 70 ? '...' : ''}</a></span></div>` : ''}
    </article>`;
  }

  // ---- 日期工具 ----
  // 关键: "2026-06-22" 这种 date-no-tz 字符串 new Date() 会当 UTC 解析,
  // 跨时区读者会算出负数或差 1 天。用本地日期解析规避。
  function parseLocalDate(dateStr) {
    if (!dateStr) return null;
    // 兼容 "2026-06-22" 和 "2026-06-22T15:35:04Z" 两种格式
    const dateOnly = String(dateStr).slice(0, 10);
    const parts = dateOnly.split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  function monthsAgo(dateStr) {
    const d = parseLocalDate(dateStr);
    if (!d) return null;
    const now = new Date();
    return Math.max(0, Math.round((now - d) / (1000 * 60 * 60 * 24 * 30)));
  }
  function daysAgo(dateStr) {
    const d = parseLocalDate(dateStr);
    if (!d) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.max(0, Math.floor((today - d) / 86400000));
  }
  function fmtPublishDate(dateStr) {
    const d = parseLocalDate(dateStr);
    if (!d) return dateStr || '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }
  function fmtFullDate(dateStr) {
    const d = parseLocalDate(dateStr);
    if (!d) return dateStr || '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // 从 generated_at (UTC ISO w/ Z, e.g. "2026-07-07T05:23:45Z") 算距今小时数。
  // 用于首页数据新鲜度红字告警; new Date() 对带 Z 的 ISO 是安全解析成 UTC 的,
  // 只有 bare YYYY-MM-DD 会被误当 UTC 天头,那种情况走 parseLocalDate。
  function hoursSinceIso(isoStr) {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return null;
    return (Date.now() - d.getTime()) / 3600000;
  }
  // 返回 {level: 'fresh'|'normal'|'stale', label: string}
  //   - fresh: <25h        → 绿色小圆点
  //   - normal: 25-72h     → 中性,不提示
  //   - stale: >72h        → 红字 "数据 N 天未更新"
  // 25h 而非 24h 是给 workflow 迟启动留 1h 缓冲, 不会人为触发一次误报
  function freshnessBadge(isoStr) {
    const h = hoursSinceIso(isoStr);
    if (h === null) return { level: 'unknown', label: '' };
    if (h < 25) return { level: 'fresh', label: '· 今日已核对' };
    if (h <= 72) return { level: 'normal', label: '' };
    const days = Math.floor(h / 24);
    return { level: 'stale', label: `· 数据 ${days} 天未更新` };
  }

  // ---- 渲染: official_update 卡片(中性 source 标签,不打颜色分,只显示元数据)----
  function renderOfficialUpdateCard(u) {
    const monthsSinceVerified = monthsAgo(u.verified_on);
    const stale = monthsSinceVerified !== null && monthsSinceVerified >= 6;
    const platformLabel = u.platform === 'google' ? 'Google' : 'Meta';
    const platformClsKey = u.platform === 'google' ? 'google' : 'meta';
    const impactLabels = { high: '高影响', medium: '中影响', low: '低影响' };

    const hasNewFormat = u.tldr && Array.isArray(u.bullets) && u.bullets.length > 0;
    let body;
    if (hasNewFormat) {
      body = `<div class="takeaway__tldr"><span class="takeaway__tldr-label">🎯</span><p>${escapeHtml(u.tldr)}</p></div>
      <ul class="takeaway__bullets">
        ${u.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}
      </ul>
      <div class="official-card__amazon ${u.amazon_actionable ? 'is-actionable' : 'is-context'}">
        <span class="official-card__amazon-label">${u.amazon_actionable ? '🎯 你能直接动手' : 'ℹ️ 上下文校准(不直接用)'}</span>
        <p>${escapeHtml(u.amazon_tip || u.amazon_actionable_reason_zh || '')}</p>
      </div>
      ${u.summary_zh ? `<details class="takeaway__detail-toggle">
        <summary>展开完整写法</summary>
        <p class="takeaway__full-summary">${escapeHtml(u.summary_zh)}</p>
      </details>` : ''}`;
    } else {
      body = `<p class="official-card__summary">${escapeHtml(u.summary_zh)}</p>
      <div class="official-card__amazon ${u.amazon_actionable ? 'is-actionable' : 'is-context'}">
        <span class="official-card__amazon-label">${u.amazon_actionable ? '🎯 你能直接动手' : 'ℹ️ 上下文校准(不直接用)'}</span>
        <p>${escapeHtml(u.amazon_actionable_reason_zh)}</p>
      </div>`;
    }

    return `<article class="official-card ${stale ? 'is-stale' : ''}">
      <div class="official-card__head">
        <span class="official-card__source">
          <span class="official-tag">官方</span>
          <span class="chip chip--platform-${platformClsKey}">${platformLabel}</span>
          <span class="official-card__publisher">${escapeHtml(u.publisher)}</span>
        </span>
        <span class="official-card__impact official-card__impact--${u.impact_level}">${impactLabels[u.impact_level] || u.impact_level}</span>
      </div>
      <h3 class="official-card__title">${escapeHtml(u.title_zh)}</h3>
      ${body}
      <div class="official-card__foot">
        <div class="chip-row">${topicChips(u.topics)}</div>
        <div class="official-card__dates">
          <span>公布 ${fmtPublishDate(u.publish_date)}</span>
          ${u.effective_date ? `<span>· 生效 ${fmtPublishDate(u.effective_date)}</span>` : ''}
          <span class="${stale ? 'verified-tag verified-tag--stale' : 'verified-tag'}">· 上次核对 ${monthsSinceVerified !== null ? `${monthsSinceVerified} 个月前` : '—'}</span>
        </div>
        ${stale ? `<div class="stale-warning">⚠️ 该信息可能已变,<a href="${escapeHtml(u.official_url)}" target="_blank" rel="noopener">点击跳转官方源核对</a></div>` : ''}
        <a class="official-card__link" href="${escapeHtml(u.official_url)}" target="_blank" rel="noopener">查看官方原文 →</a>
      </div>
    </article>`;
  }

  // ---- 路由 ----
  function navigate() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const [path, query] = hash.split('?');
    const params = new URLSearchParams(query || '');
    const segs = path.split('/').filter(Boolean);

    // 高亮当前 nav
    const navKey = segs[0] || 'home';
    $nav.forEach(a => a.classList.toggle('active', a.dataset.nav === navKey));

    if (segs.length === 0) return renderHome();
    if (segs[0] === 'playbook') return renderPlaybook();
    if (segs[0] === 'updates') return renderUpdates();
    if (segs[0] === 'topics' && segs.length === 1) return renderTopicList();
    if (segs[0] === 'topics' && segs.length === 2) return renderTopicDetail(segs[1]);
    if (segs[0] === 'channels' && segs.length === 1) return renderChannelList();
    if (segs[0] === 'channels' && segs.length === 2) return renderChannelDetail(segs[1]);
    if (segs[0] === 'videos' && segs.length === 2) return renderVideoDetail(segs[1], +params.get('t') || 0);
    if (segs[0] === 'search') return renderSearch(params.get('q') || '');
    if (segs[0] === 'about') return renderAbout();
    return renderNotFound();
  }
  window.addEventListener('hashchange', navigate);

  // ---- Home ----
  function renderHome() {
    const topTopics = [...data.topics].sort((a, b) => b.takeaway_count - a.takeaway_count).slice(0, 8);
    const topChannels = [...data.channels].sort((a, b) => b.takeaway_count - a.takeaway_count);
    // 精选 6 条:amazon_relevance=high 优先,同级按文件顺序(不假装是"最新")
    const highTakeaways = data.takeaways.filter(t => t.amazon_relevance === 'high');
    const picked = highTakeaways.slice(0, 6);
    const highCount = highTakeaways.length;
    // 近期核对的官方动态 top 3 (verified_on desc, 平局按 effective_date desc)
    const officials = (data.official_updates || []).slice().sort((a, b) => {
      const av = a.verified_on || '', bv = b.verified_on || '';
      if (av !== bv) return bv.localeCompare(av);
      const ae = a.effective_date || '', be = b.effective_date || '';
      return be.localeCompare(ae);
    }).slice(0, 3);
    // 数据核对日期 = generated_at 的日期部分
    const buildDate = fmtFullDate(data.generated_at) || '—';
    const fresh = freshnessBadge(data.generated_at);
    $app.innerHTML = `
      <section class="hero">
        <p class="hero__kicker">Gracexiaoe · 效果投放学习库</p>
        <h1 class="hero__title">效果投放 · DTC <em>×</em> Amazon</h1>
        <p class="hero__lede">每条带 ▶ YouTube 时间戳。<strong>🎯 Amazon 可落地</strong>(${highCount} 条)+ <strong>📖 DTC 视野</strong>(${data.takeaways.length - highCount} 条),分类阅读。</p>
        <div class="hero__cta">
          <a href="#/playbook" class="btn btn--primary">📘 PLAYBOOK · 20 条 Amazon 落地</a>
          <button class="btn btn--ghost" id="open-assistant-cta">💧 小助手</button>
          <a href="#/topics/" class="btn btn--text">主题 →</a>
        </div>
        <div class="hero__stats">
          <div class="stat"><span class="stat__num">${data.takeaways.length}</span><span class="stat__label">Takeaway</span></div>
          <div class="stat"><span class="stat__num">${data.channels.length}</span><span class="stat__label">博主</span></div>
          <div class="stat"><span class="stat__num">${data.videos.length}</span><span class="stat__label">视频</span></div>
          <div class="stat"><span class="stat__num">${highCount}</span><span class="stat__label">🎯 Amazon 落地</span></div>
        </div>
        <div class="hero__meta">
          <span class="hero__meta-item">📅 数据核对 · <strong>${buildDate}</strong>${fresh.label ? ` <span class="hero__freshness hero__freshness--${fresh.level}">${fresh.label}</span>` : ''}</span>
          <span class="hero__meta-item">📚 v1 · 语料 ${data.takeaways.length} + 官方 ${(data.official_updates || []).length}</span>
          <details class="hero__changelog">
            <summary>更新记录</summary>
            <ul>
              <li><strong>${buildDate}</strong> · v1.0 首发 · ${data.channels.length} 位博主 · ${data.takeaways.length} 条 takeaway · ${(data.official_updates || []).length} 条官方动态(Google + Meta)</li>
            </ul>
            <p class="hero__changelog-note">这是一份 <strong>v1 snapshot</strong>,不是实时 feed。看到 Amazon/Google/Meta 有新规则,我会重跑脚本追加一版;每次真更新都会在这里加一行。</p>
          </details>
        </div>
      </section>

      ${officials.length ? `
      <h2>官方动态 · 近期核对</h2>
      <p class="lede lede--tight">Google / Meta 官方规则,已核对到最新日期。带 <strong>生效日</strong>的是硬时间线,请在到期前完成迁移。</p>
      <div class="grid grid--officials-home">
        ${officials.map(renderOfficialUpdateCard).join('')}
      </div>
      <p class="see-all"><a href="#/updates">看全部 ${(data.official_updates || []).length} 条官方动态 →</a></p>
      ` : ''}

      <h2>热门主题</h2>
      <div class="grid grid--topics">
        ${topTopics.map(t => `
          <a class="card" href="#/topics/${t.slug}">
            <span class="card__kicker">${escapeHtml(t.slug)}</span>
            <span class="card__title">${escapeHtml(t.label_zh)}</span>
            <span class="card__desc">${escapeHtml(t.desc)}</span>
            <span class="card__meta"><strong>${t.takeaway_count}</strong> takeaway · ${t.channels_covered.length} 博主</span>
          </a>
        `).join('')}
      </div>

      <h2>博主</h2>
      <div class="grid grid--channels">
        ${topChannels.map(ch => `
          <a class="card" href="#/channels/${ch.slug}">
            <span class="card__kicker">${platformChip(ch.platform)} · ${escapeHtml(ch.handle || '')}</span>
            <span class="card__title">${escapeHtml(ch.name)}</span>
            <span class="card__desc">${escapeHtml(ch.role)}</span>
            <span class="card__meta">
              <span><strong>${ch.takeaway_count}</strong> takeaway</span>
              <span><strong>${ch.video_count}</strong> 视频</span>
            </span>
          </a>
        `).join('')}
      </div>

      <h2>精选 takeaway <span class="h2__note" title="Amazon 相关度 = 高 的前 6 条。不按时间排,因 takeaway 无入库时间字段。">?</span></h2>
      <p class="lede lede--tight">从 ${highCount} 条高相关里挑的 6 条入门。想按主题/博主浏览请用 <a href="#/topics/">主题</a> / <a href="#/channels/">博主</a> 页。</p>
      <div class="grid grid--takeaways">
        ${picked.map(renderTakeawayCard).join('')}
      </div>
    `;
  }

  // ---- Topics list ----
  function renderTopicList() {
    $app.innerHTML = `
      <h1>所有主题</h1>
      <p class="lede">17 个预设主题 · 每条 takeaway ≥ 1 个主题。</p>
      <div class="grid grid--topics">
        ${data.topics.map(t => `
          <a class="card" href="#/topics/${t.slug}">
            <span class="card__kicker">${escapeHtml(t.slug)}</span>
            <span class="card__title">${escapeHtml(t.label_zh)}</span>
            <span class="card__desc">${escapeHtml(t.desc)}</span>
            <span class="card__meta">
              <span><strong>${t.takeaway_count}</strong> takeaway</span>
              <span><strong>${t.channels_covered.length}</strong> 博主</span>
            </span>
          </a>
        `).join('')}
      </div>
    `;
  }

  // ---- Topic detail (按博主分组) ----
  function renderTopicDetail(slug) {
    const topic = byTopicSlug.get(slug);
    if (!topic) return renderNotFound();
    const items = topic.takeaway_ids.map(id => takeawayById.get(id)).filter(Boolean);
    // 按 channel 分组
    const grouped = {};
    for (const t of items) {
      (grouped[t.channel_slug] ||= []).push(t);
    }
    $app.innerHTML = `
      <p class="card__kicker"><a href="#/topics/">← 全部主题</a></p>
      <h1>${escapeHtml(topic.label_zh)}</h1>
      <p class="lede">${escapeHtml(topic.desc)}</p>

      <div class="filter-bar">
        <label>Amazon 相关度:</label>
        <select id="filter-rel">
          <option value="">全部</option>
          <option value="high">仅 Amazon 高相关</option>
          <option value="medium">中 + 高</option>
          <option value="low">低 (DTC 视角)</option>
        </select>
        <span style="color:#888">共 ${items.length} 条 · ${topic.channels_covered.length} 博主覆盖</span>
      </div>

      <div id="topic-body">
        ${Object.entries(grouped).map(([chSlug, ts]) => {
          const ch = byChannelSlug.get(chSlug);
          return `<section data-channel="${chSlug}">
            <h2>${ch ? escapeHtml(ch.name) : chSlug} ${ch ? platformChip(ch.platform) : ''}</h2>
            <div class="grid grid--takeaways">
              ${ts.map(t => renderTakeawayCard(t, { topicSlug: slug })).join('')}
            </div>
          </section>`;
        }).join('')}
      </div>
    `;
    document.getElementById('filter-rel').addEventListener('change', e => {
      const want = e.target.value;
      document.querySelectorAll('#topic-body .takeaway').forEach(el => {
        const rel = el.querySelector('[class*="chip--rel-"]');
        const r = rel ? rel.className.match(/chip--rel-(\w+)/)[1] : 'none';
        let show = !want || want === r || (want === 'medium' && r === 'high');
        el.style.display = show ? '' : 'none';
      });
    });
  }

  // ---- Channel list ----
  function renderChannelList() {
    $app.innerHTML = `
      <h1>所有博主</h1>
      <p class="lede">10 个 DTC 重点博主 · Meta / Google 各占半壁。</p>
      <div class="grid grid--channels">
        ${data.channels.map(ch => `
          <a class="card" href="#/channels/${ch.slug}">
            <span class="card__kicker">${platformChip(ch.platform)} · ${escapeHtml(ch.handle || '')}</span>
            <span class="card__title">${escapeHtml(ch.name)}</span>
            <span class="card__desc">${escapeHtml(ch.role)}</span>
            <span class="card__desc" style="font-size:13px">${escapeHtml(ch.why)}</span>
            <span class="card__meta">
              <span><strong>${ch.takeaway_count}</strong> takeaway</span>
              <span><strong>${ch.video_count}</strong> 视频</span>
              <span><a href="${escapeHtml(ch.url)}" target="_blank">YouTube ↗</a></span>
            </span>
          </a>
        `).join('')}
      </div>
    `;
  }

  // ---- Channel detail ----
  function renderChannelDetail(slug) {
    const ch = byChannelSlug.get(slug);
    if (!ch) return renderNotFound();
    const ts = data.takeaways.filter(t => t.channel_slug === slug);
    $app.innerHTML = `
      <p class="card__kicker"><a href="#/channels/">← 全部博主</a></p>
      <div class="channel-hero">
        <h1>${escapeHtml(ch.name)} ${platformChip(ch.platform)}</h1>
        <div class="channel-hero__handle">${escapeHtml(ch.handle || '')} · <a href="${escapeHtml(ch.url)}" target="_blank">YouTube ↗</a></div>
        <p style="margin-top:12px;color:var(--ink-soft)">${escapeHtml(ch.role)}</p>
        <p style="color:var(--ink-soft)">为什么值得看: ${escapeHtml(ch.why)}</p>
        <div class="channel-hero__row">
          <span><strong>${ch.takeaway_count}</strong> takeaway</span>
          <span><strong>${ch.video_count}</strong> 视频</span>
          <span>主讲: ${(ch.top_topics || []).slice(0, 3).map(x => {
            const m = byTopicSlug.get(x.slug);
            return `<a href="#/topics/${x.slug}">${escapeHtml(m ? m.label_zh : x.slug)}</a> (${x.count})`;
          }).join(' · ')}</span>
        </div>
      </div>
      <h2>该博主的 ${ts.length} 条 takeaway</h2>
      <div class="grid grid--takeaways">
        ${ts.map(t => renderTakeawayCard(t)).join('')}
      </div>
    `;
  }

  // ---- Video detail ----
  function renderVideoDetail(vid, startSec) {
    const v = byVideoId.get(vid);
    if (!v) return renderNotFound();
    const ch = byChannelSlug.get(v.channel_slug);
    const ts = data.takeaways.filter(t => t.video_id === vid).sort((a, b) => a.timestamp_seconds - b.timestamp_seconds);
    $app.innerHTML = `
      <p class="card__kicker">
        <a href="#/channels/${v.channel_slug}">← ${ch ? escapeHtml(ch.name) : v.channel_slug}</a>
      </p>
      <h1 style="font-size:26px">${escapeHtml(v.title)}</h1>
      <div class="video-detail-grid">
        <div>
          <iframe id="video-iframe" class="video-frame" src="${ytEmbed(vid, startSec)}" frameborder="0" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen></iframe>
          <p style="margin-top:8px;font-size:13px;color:var(--ink-faint)">
            ⏱ ${fmtSec(v.duration)} · 👁 ${v.view_count.toLocaleString()}${v.upload_date ? ` · 📅 ${escapeHtml(v.upload_date)}` : ''} ·
            <a href="${ytWatch(vid, startSec)}" target="_blank">在 YouTube 打开 ↗</a>
          </p>
        </div>
        <div>
          <h2 style="margin-top:0">这个视频的 takeaway (${ts.length})</h2>
          ${ts.map(t => renderTakeawayCard(t)).join('')}
        </div>
      </div>
    `;
    // 时间戳点击 = 重置 iframe src
    document.querySelectorAll('[data-jump]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const sec = +a.dataset.jump;
        document.getElementById('video-iframe').src = ytEmbed(vid, sec);
      });
    });
  }

  // ---- Search ----
  function renderSearch(q) {
    if (!q) {
      $app.innerHTML = `<h1>搜索</h1><p class="lede">在顶部输入框搜索,或按 <kbd>/</kbd> 聚焦。</p>`;
      return;
    }
    const results = window.FUSE.search(q).slice(0, 50);
    $app.innerHTML = `
      <h1>搜索: <em style="font-family:'IBM Plex Mono'">${escapeHtml(q)}</em></h1>
      <p class="lede">${results.length} 个结果</p>
      ${results.length === 0 ? '<div class="empty">没有匹配,试试别的词</div>' : results.map(r => {
        const it = r.item;
        if (it.type === 'takeaway') {
          const ch = byChannelSlug.get(it.channel_slug);
          return `<div class="search-result-item">
            <div class="card__kicker">${ch ? escapeHtml(ch.name) : it.channel_slug} · TAKEAWAY · ${fmtSec(it.timestamp_seconds)}</div>
            <h3 style="margin:6px 0"><a href="#/videos/${it.video_id}?t=${it.timestamp_seconds}">${window.highlightMatches(it.title, r.matches, 'title')}</a></h3>
            <p style="color:var(--ink-soft);font-size:14px">${window.highlightMatches(it.summary, r.matches, 'summary')}</p>
            ${it.quote ? `<p style="font-style:italic;color:var(--ink-faint);font-size:13px">"${window.highlightMatches(it.quote, r.matches, 'quote')}"</p>` : ''}
          </div>`;
        }
        if (it.type === 'channel') {
          return `<div class="search-result-item">
            <div class="card__kicker">CHANNEL</div>
            <h3 style="margin:6px 0"><a href="#/channels/${it.slug}">${window.highlightMatches(it.title, r.matches, 'title')}</a></h3>
            <p style="color:var(--ink-soft);font-size:14px">${window.highlightMatches(it.summary, r.matches, 'summary')}</p>
          </div>`;
        }
        if (it.type === 'topic') {
          return `<div class="search-result-item">
            <div class="card__kicker">TOPIC</div>
            <h3 style="margin:6px 0"><a href="#/topics/${it.slug}">${window.highlightMatches(it.title, r.matches, 'title')}</a></h3>
            <p style="color:var(--ink-soft);font-size:14px">${window.highlightMatches(it.summary, r.matches, 'summary')}</p>
          </div>`;
        }
        return '';
      }).join('')}
    `;
  }

  // ---- Playbook (renders PLAYBOOK.md inline) ----
  async function renderPlaybook() {
    $app.innerHTML = `<div class="loading">载入 PLAYBOOK…</div>`;
    try {
      const r = await fetch('assets/PLAYBOOK.md', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const md = await r.text();
      const html = window.marked
        ? window.marked.parse(md, { gfm: true, breaks: false })
        : `<pre>${escapeHtml(md)}</pre>`;
      $app.innerHTML = `
        <p class="card__kicker"><a href="#/">← 返回主页</a></p>
        <article class="playbook">${html}</article>
        <div class="playbook__foot">
          <p>读完了。下一步:</p>
          <div class="hero__cta">
            <a href="#/topics/" class="btn btn--ghost">浏览全部 17 个主题</a>
            <a href="#/channels/" class="btn btn--ghost">查看 10 位博主</a>
            <button class="btn btn--text" id="open-assistant-foot">💧 还有问题?问小助手</button>
          </div>
        </div>
      `;
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (e) {
      $app.innerHTML = `<div class="empty">
        <h2>PLAYBOOK 读取失败</h2>
        <p>${escapeHtml(e.message)}</p>
        <p><a href="#/">回主页</a></p>
      </div>`;
    }
  }

  // ---- 官方动态 ----
  function renderUpdates() {
    const updates = (DATA.official_updates || []).slice()
      .sort((a, b) => (b.publish_date || '').localeCompare(a.publish_date || ''));
    const total = updates.length;
    const actionableCount = updates.filter(u => u.amazon_actionable).length;
    const googleCount = updates.filter(u => u.platform === 'google').length;
    const metaCount = updates.filter(u => u.platform === 'meta').length;

    $app.innerHTML = `
      <section class="page page--updates">
        <header class="page__head">
          <span class="page__kicker">📋 OFFICIAL UPDATES</span>
          <h1>官方动态 <span class="page__count">· ${total} 条</span></h1>
          <p class="page__manifesto">
            🎯 能直接动手 · ℹ️ 上下文校准博主旧教程。<br>
            每条带"核对于 YYYY-MM-DD",超过 6 个月自动灰化,<u>请跳官方源核对</u>。
          </p>
        </header>
        <div class="updates-filter" id="updates-filter">
          <button class="updates-filter__btn is-active" data-filter="all">全部 (${total})</button>
          <button class="updates-filter__btn" data-filter="actionable">🎯 能直接动手 (${actionableCount})</button>
          <button class="updates-filter__btn" data-filter="context">ℹ️ 上下文校准 (${total - actionableCount})</button>
          <button class="updates-filter__btn" data-filter="google">Google (${googleCount})</button>
          <button class="updates-filter__btn" data-filter="meta">Meta (${metaCount})</button>
        </div>
        <div class="updates-list" id="updates-list">
          ${updates.map(renderOfficialUpdateCard).join('')}
        </div>
      </section>
    `;

    // 过滤 handler
    const filterBtns = $app.querySelectorAll('.updates-filter__btn');
    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const f = btn.dataset.filter;
        const filtered = f === 'all' ? updates :
          f === 'actionable' ? updates.filter(u => u.amazon_actionable) :
          f === 'context' ? updates.filter(u => !u.amazon_actionable) :
          f === 'google' ? updates.filter(u => u.platform === 'google') :
          f === 'meta' ? updates.filter(u => u.platform === 'meta') : updates;
        $app.querySelector('#updates-list').innerHTML = filtered.map(renderOfficialUpdateCard).join('') || `<p class="empty">这个筛选下没有更新。</p>`;
      });
    });
  }

  // ---- About ----
  function renderAbout() {
    $app.innerHTML = `
      <h1>关于这个站</h1>
      <p class="lede">Grace 入职 1 年的优化师 · 主做 Amazon 引流 · 自学 DTC 投放方法论的知识库。</p>

      <h2>它是怎么生成的</h2>
      <p>每个 takeaway 都来自真实的 YouTube 视频字幕,经过 Claude (claude-haiku-4-5) 提炼,带原始 quote 和时间戳。点 ▶ 时间戳能直接跳到视频那一秒。</p>

      <h2>为什么不是 RAG chatbot</h2>
      <p>知识库的目的是<strong>让人去看</strong>而不是替人看。RAG chatbot 让人越来越懒;手动浏览 + 跳 YouTube 验证 + 自己消化,才会真的内化成能力。</p>

      <h2>怎么扩展</h2>
      <ol>
        <li>编辑 <code>config/channels.json</code> 加新博主</li>
        <li>跑 <code>scripts/01_collect_video_urls.sh</code></li>
        <li>跑 <code>scripts/02_download_subtitles.sh</code></li>
        <li>跑 <code>scripts/03_extract_takeaways.py</code></li>
        <li>跑 <code>scripts/04_aggregate_topics.py</code></li>
        <li>刷新本页</li>
      </ol>

      <h2>已知限制</h2>
      <ul>
        <li>仅英文字幕(中文博主 v2 加)</li>
        <li>auto-gen 字幕偶有错词,quote 看着别扭可点 ▶ 跳到 YouTube 自己听</li>
        <li>topic 标签是 Claude 提的,不一定 100% 准</li>
      </ul>
    `;
  }

  // ---- 404 ----
  function renderNotFound() {
    $app.innerHTML = `<div class="empty">
      <h2>页面不存在</h2>
      <p>试试 <a href="#/">主页</a>,或者搜索一下。</p>
    </div>`;
  }

  // ---- 搜索框交互 ----
  let searchTimer;
  $search.addEventListener('input', e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => {
      if (q) location.hash = '#/search?q=' + encodeURIComponent(q);
    }, 250);
  });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== $search) {
      e.preventDefault(); $search.focus();
    }
    if (e.key === 'Escape' && document.activeElement === $search) {
      $search.blur(); $search.value = '';
    }
  });

  // ---- 启动 ----
  navigate();
})();
