#!/usr/bin/env python3
"""Print full message text for chats by index range from window-messages.json."""
import json, os, sys
_WMJSON = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "eval", "window-messages.json")
d = json.load(open(_WMJSON, encoding='utf-8'))
idxs = [int(x) for x in sys.argv[1:]]
for i in idxs:
    c = d['chats'][i]
    print(f"\n########## [{i}] {c['name']} ({'群' if c['isGroup'] else '1對1'}) msgs={len(c['messages'])} ##########")
    for m in c['messages']:
        who = '我' if m['direction'] == 'out' else m['sender']
        t = m['time'][5:16] if m['time'] else '?'
        print(f"[{t}] {who}: {m['text']}")
