import re
import os

def clean_vtt(path):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    content = re.sub(r'<\d{2}:\d{2}:\d{2}\.\d{3}>', '', content)
    content = re.sub(r'</?c>', '', content)
    lines = content.split('\n')
    output = []
    last_text = ''
    current_ts = None
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line == 'WEBVTT' or line.startswith('Kind:') or line.startswith('Language:'):
            continue
        m = re.match(r'(\d{2}):(\d{2}):(\d{2})\.\d{3}\s*-->', line)
        if m:
            h, mm, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
            current_ts = h*3600 + mm*60 + s
            continue
        if line != last_text and not re.match(r'^\d+$', line):
            output.append(f"[{current_ts}s] {line}")
            last_text = line
    return '\n'.join(output)

src = '/Users/gracewang/dtc-knowledge-base/raw/the-google-pro'
out = '/Users/gracewang/dtc-knowledge-base/processed/.cleaned_tgp'
os.makedirs(out, exist_ok=True)
for f in sorted(os.listdir(src)):
    if f.endswith('.vtt'):
        vid = f.replace('.en.vtt', '')
        txt = clean_vtt(os.path.join(src, f))
        with open(os.path.join(out, vid + '.txt'), 'w') as wf:
            wf.write(txt)
        print(f"{vid}: {len(txt)} chars")
