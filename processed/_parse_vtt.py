#!/usr/bin/env python3
"""Parse VTT, dedupe YouTube auto-caption repetition, output transcript with timestamps."""
import re
import sys
import os
import json

def parse_vtt(path):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    blocks = re.split(r'\n\n+', content)
    cues = []
    for block in blocks:
        lines = block.strip().split('\n')
        ts_idx = None
        for i, line in enumerate(lines):
            if '-->' in line:
                ts_idx = i
                break
        if ts_idx is None:
            continue
        ts = lines[ts_idx]
        m = re.match(r'(\d+):(\d+):(\d+)\.(\d+)\s+-->', ts)
        if not m:
            continue
        h, mn, s, ms = m.groups()
        start_s = int(h)*3600 + int(mn)*60 + int(s)
        text_lines = lines[ts_idx+1:]
        # Strip <tags> and timestamps from each line
        cleaned_lines = []
        for ln in text_lines:
            cl = re.sub(r'<[^>]+>', '', ln)
            cl = re.sub(r'\s+', ' ', cl).strip()
            if cl:
                cleaned_lines.append(cl)
        if not cleaned_lines:
            continue
        # YouTube auto-captions: each cue has [previous_line, new_line]
        # The "new" content is usually the LAST non-empty line
        text = cleaned_lines[-1]
        cues.append((start_s, text))
    # Now dedupe: skip cue whose text already appears in prior accepted cues
    deduped = []
    seen_recent = []
    for t, txt in cues:
        # Skip exact match with last appended
        if deduped and deduped[-1][1] == txt:
            continue
        # Skip if this is a prefix of the prior line (means it was a stale intermediate)
        if deduped and deduped[-1][1].startswith(txt) and len(txt) < len(deduped[-1][1]):
            continue
        deduped.append((t, txt))
    return deduped

def format_transcript(cues, max_seconds=1500, max_chars=20000):
    lines = []
    total = 0
    for t, txt in cues:
        if t > max_seconds:
            break
        line = f"[{t}] {txt}"
        if total + len(line) > max_chars:
            break
        lines.append(line)
        total += len(line) + 1
    return '\n'.join(lines)

if __name__ == '__main__':
    raw_dir = '/Users/gracewang/dtc-knowledge-base/raw/ed-leake'
    out_dir = '/Users/gracewang/dtc-knowledge-base/processed/_ed-leake-transcripts'
    os.makedirs(out_dir, exist_ok=True)
    summary = {}
    for fn in sorted(os.listdir(raw_dir)):
        if not fn.endswith('.en.vtt'):
            continue
        vid = fn.replace('.en.vtt', '')
        cues = parse_vtt(os.path.join(raw_dir, fn))
        transcript = format_transcript(cues)
        with open(os.path.join(out_dir, f'{vid}.txt'), 'w') as f:
            f.write(transcript)
        # also write a flat plain-text version (no timestamps)
        flat = ' '.join(t for _, t in cues)
        flat = re.sub(r'\s+', ' ', flat).strip()
        with open(os.path.join(out_dir, f'{vid}.flat.txt'), 'w') as f:
            f.write(flat)
        summary[vid] = {
            'cues': len(cues),
            'last_ts': cues[-1][0] if cues else 0,
            'transcript_chars': len(transcript),
        }
    print(json.dumps(summary, indent=2))
