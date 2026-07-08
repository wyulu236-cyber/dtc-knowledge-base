import re, sys, os, glob

src = '/Users/gracewang/dtc-knowledge-base/raw/andrew-lolk'
dst = '/Users/gracewang/dtc-knowledge-base/raw/andrew-lolk/_clean'
os.makedirs(dst, exist_ok=True)

for f in sorted(glob.glob(src + '/*.en.vtt')):
    with open(f) as h:
        content = h.read()
    lines = content.split('\n')
    # Build (ts, text) pairs
    pairs = []
    cur_ts = 0
    for ln in lines:
        if ln.startswith('WEBVTT') or ln.startswith('Kind:') or ln.startswith('Language:'):
            continue
        if '-->' in ln:
            m = re.match(r'(\d+):(\d+):(\d+)\.\d+', ln)
            if m:
                hh, mn, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
                cur_ts = hh*3600 + mn*60 + s
            continue
        cleaned = re.sub(r'<[^>]+>', '', ln).strip()
        if cleaned:
            pairs.append((cur_ts, cleaned))
    # Dedupe text
    seen = set()
    out = []
    last_ts_emitted = -100
    buf = []
    for ts, txt in pairs:
        if txt in seen:
            continue
        seen.add(txt)
        # emit timestamp marker every ~30 sec
        if ts - last_ts_emitted >= 30:
            if buf:
                out.append(' '.join(buf))
                buf = []
            out.append(f'[{ts}s]')
            last_ts_emitted = ts
        buf.append(txt)
    if buf:
        out.append(' '.join(buf))
    name = os.path.basename(f).replace('.en.vtt', '.txt')
    with open(os.path.join(dst, name), 'w') as w:
        w.write('\n'.join(out))
    print(name, sum(1 for x in out if not x.startswith('[')))
