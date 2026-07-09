#!/usr/bin/env python3
"""Organize the last 2 days of LINE conversations (both directions), grouped by
chat. Writes a full Markdown digest to <repo>/digest_2days.md and prints a
compact per-chat overview to stdout."""
import datetime, os
from collections import OrderedDict
import linedb, linekey

con = linedb.open_db()
me = linedb.my_mid(con)
now = datetime.datetime.now()
today0 = datetime.datetime(now.year, now.month, now.day)
start = today0 - datetime.timedelta(days=1)          # yesterday 00:00 -> covers 2 days
start_ms = int(start.timestamp() * 1000)

rows = con.execute(
    "SELECT _chatId,_createdTime,_from,_text,_contentType FROM _message "
    "WHERE _createdTime>=? ORDER BY _createdTime", (start_ms,)).fetchall()

chats = OrderedDict()
for cid, t, frm, text, ct in rows:
    body = text if text else (linedb.CT.get(ct) or f"[{ct}]")
    who = "我" if frm == me else (linedb.chat_name(con, frm) or frm)
    chats.setdefault(cid, []).append((linedb.iso(t), "out" if frm == me else "in", who, body))

ordered = sorted(chats.items(), key=lambda kv: kv[1][-1][0], reverse=True)

# ---- full markdown ----
md = [f"# LINE 對話整理 {start.strftime('%Y-%m-%d')} ~ {now.strftime('%Y-%m-%d')}",
      f"\n> {len(ordered)} 個對話，共 {sum(len(v) for _,v in chats.items())} 則\n"]
for cid, msgs in ordered:
    name = linedb.chat_name(con, cid) or cid
    kind = "群組" if cid[:1] != "u" else "1:1"
    nin = sum(1 for m in msgs if m[1] == "in"); nout = len(msgs) - nin
    md.append(f"\n## {name}  ({kind}, 收{nin}/發{nout})\n")
    cur = None
    for tm, d, who, body in msgs:
        day = tm[:10]
        if day != cur:
            md.append(f"\n**{day}**\n"); cur = day
        arrow = "→我發" if d == "out" else f"←{who}"
        md.append(f"- `{tm[11:16]}` {arrow}: {body.strip()}")
out = os.path.join(linekey.REPO_ROOT, "digest_2days.md")
open(out, "w", encoding="utf-8").write("\n".join(md))
print(f"[+] 完整版寫入 {out}\n")

# ---- compact console overview ----
print(f"兩天共 {len(ordered)} 對話 / {sum(len(v) for _,v in chats.items())} 則\n")
for cid, msgs in ordered:
    name = linedb.chat_name(con, cid) or cid
    kind = "群" if cid[:1] != "u" else "1對1"
    nin = sum(1 for m in msgs if m[1] == "in"); nout = len(msgs) - nin
    print(f"===== {name} [{kind}] 收{nin}/發{nout} =====")
    for tm, d, who, body in msgs[-14:]:
        b = body.strip().replace("\n", " ⏎ ")
        if len(b) > 64:
            b = b[:64] + "…"
        tag = "我" if d == "out" else who
        print(f"  {tm[5:16]} {tag}: {b}")
    print()
