// search.js — Fuse.js fuzzy 搜索, 跨 takeaway/channel/topic
// 输入: window.DATA (由 app.js 加载完后赋值)
// 暴露: window.runSearch(query)

window.buildFuse = function(data) {
  const items = [];
  for (const t of data.takeaways) {
    items.push({
      type: 'takeaway',
      id: t.id,
      video_id: t.video_id,
      title: t.title_zh,
      summary: t.summary_zh,
      quote: t.quote_en,
      topics: (t.topics || []).join(' '),
      channel_slug: t.channel_slug,
      timestamp_seconds: t.timestamp_seconds,
      amazon_relevance: t.amazon_relevance,
    });
  }
  for (const ch of data.channels) {
    items.push({
      type: 'channel',
      slug: ch.slug,
      title: ch.name,
      summary: ch.role + ' · ' + ch.why,
    });
  }
  for (const tp of data.topics) {
    items.push({
      type: 'topic',
      slug: tp.slug,
      title: tp.label_zh,
      summary: tp.desc,
    });
  }
  for (const u of (data.official_updates || [])) {
    items.push({
      type: 'official',
      id: u.id,
      title: u.title_zh,
      summary: u.summary_zh,
      quote: u.amazon_actionable_reason_zh || '',
      topics: (u.topics || []).join(' '),
      channel_slug: u.publisher,
    });
  }
  const fuse = new Fuse(items, {
    keys: [
      { name: 'title',   weight: 0.4 },
      { name: 'summary', weight: 0.25 },
      { name: 'quote',   weight: 0.2 },
      { name: 'topics',  weight: 0.1 },
      { name: 'channel_slug', weight: 0.05 },
    ],
    includeMatches: true,
    threshold: 0.38,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
  return fuse;
};

window.highlightMatches = function(text, matches, key) {
  if (!matches) return escapeHtml(text || '');
  const m = matches.find(x => x.key === key);
  if (!m || !m.indices) return escapeHtml(text || '');
  let out = '';
  let cursor = 0;
  for (const [start, end] of m.indices) {
    if (start > cursor) out += escapeHtml(text.slice(cursor, start));
    out += '<mark>' + escapeHtml(text.slice(start, end + 1)) + '</mark>';
    cursor = end + 1;
  }
  out += escapeHtml(text.slice(cursor));
  return out;
};

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
window.escapeHtml = escapeHtml;
