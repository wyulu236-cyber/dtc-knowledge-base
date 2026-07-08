#\!/usr/bin/env python3
"""Convert VTT to clean text with chunked timestamps."""
import re, sys, os

def parse_vtt(path):
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read()
    lines = text.split('\n')
    out = []
    cur_time = None
    seen_recent = []
    for line in lines:
        line = line.strip()
        m = re.match(r'(\d+):(\d+):(\d+)\.\d+\s+-->', line)
        if m:
            h, mn, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
            cur_time = h*3600 + mn*60 + s
            continue
        if not line or line.startswith('WEBVTT') or line.startswith('Kind:') or line.startswith('Language:') or line.startswith('NOTE'):
            continue
        clean = re.sub(r'<[^>]+>', '', line).strip()
        if not clean:
            continue
        # Skip if exactly equal to one of last 5
        key = clean.lower()
        if key in seen_recent[-5:]:
            continue
        seen_recent.append(key)
        if cur_time is not None:
            out.append((cur_time, clean))
    return out

def chunk(segments, chunk_secs=90):
    if not segments:
        return []
    chunks = []
    cur_start = segments[0][0]
    cur_text = []
    for t, txt in segments:
        if t - cur_start >= chunk_secs and cur_text:
            chunks.append((cur_start, ' '.join(cur_text)))
            cur_start = t
            cur_text = [txt]
        else:
            cur_text.append(txt)
    if cur_text:
        chunks.append((cur_start, ' '.join(cur_text)))
    return chunks

if __name__ == '__main__':
    vtt_dir = '/Users/gracewang/dtc-knowledge-base/raw/ppc-mastery'
    out_dir = '/Users/gracewang/dtc-knowledge-base/processed/_ppc_clean'
    os.makedirs(out_dir, exist_ok=True)
    for fn in sorted(os.listdir(vtt_dir)):
        if not fn.endswith('.vtt'):
            continue
        vid = fn.replace('.en.vtt', '')
        segs = parse_vtt(os.path.join(vtt_dir, fn))
        chunks = chunk(segs, 90)
        out_path = os.path.join(out_dir, vid + '.txt')
        with open(out_path, 'w') as f:
            for t, txt in chunks:
                f.write(f"[{t}s] {txt}\n\n")
        print(f"{vid}: {len(segs)} segs, {len(chunks)} chunks", file=sys.stderr)
