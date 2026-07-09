#!/usr/bin/env python3
"""List messages RECEIVED today, grouped by chat (incoming only)."""
import datetime, sys
from collections import OrderedDict
import linedb

con = linedb.open_db()
me = linedb.my_mid(con)
now = datetime.datetime.now()
start_ms = int(datetime.datetime(now.year, now.month, now.day).timestamp() * 1000)

rows = con.execute(
    "SELECT _chatId,_createdTime,_from,_text,_contentType FROM _message "
    "WHERE _createdTime>=? ORDER BY _createdTime", (start_ms,)).fetchall()

chats = OrderedDict()
for cid, t, frm, text, ct in rows:
    if frm == me:
        continue  # only what others sent ME
    body = text if text else (linedb.CT.get(ct) or f"[{ct}]")
    body = body.replace("\n", " ⏎ ")
    if len(body) > 80:
        body = body[:80] + "…"
    chats.setdefault(cid, []).append((linedb.iso(t)[11:16],
                                      linedb.chat_name(con, frm) or frm, body))

# order chats by most recent activity (last in list)
ordered = sorted(chats.items(), key=lambda kv: kv[1][-1][0], reverse=True)
print(f"今天收到訊息的對話數: {len(ordered)}；總收到訊息: {sum(len(v) for _,v in chats.items())}\n")
for cid, msgs in ordered:
    name = linedb.chat_name(con, cid) or cid
    kind = "群組" if cid[:1] != "u" else "1:1"
    print(f"===== {name} [{kind}] — {len(msgs)} 則 =====")
    for tm, sender, body in msgs[-18:]:
        who = "" if kind == "1:1" else f"{sender}: "
        print(f"  {tm} {who}{body}")
    print()
