#!/usr/bin/env python3
"""Dump all LINE messages in the 2026-06-25 ~ 2026-06-26 window (inclusive of
both full days) grouped by chat into a structured JSON file. This is the SHARED
input for both the gold-standard (Claude) and qwen evaluations."""
import datetime, json, os, sys
from collections import OrderedDict
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))
import linedb

# Explicit window: 2026-06-25 00:00:00 .. 2026-06-27 00:00:00 (exclusive)
START = datetime.datetime(2026, 6, 25, 0, 0, 0)
END   = datetime.datetime(2026, 6, 27, 0, 0, 0)
start_ms = int(START.timestamp() * 1000)
end_ms   = int(END.timestamp() * 1000)

con = linedb.open_db()
me = linedb.my_mid(con)

rows = con.execute(
    "SELECT _chatId,_createdTime,_from,_text,_contentType,_id FROM _message "
    "WHERE _createdTime>=? AND _createdTime<? ORDER BY _createdTime",
    (start_ms, end_ms),
).fetchall()

chats = OrderedDict()
for cid, t, frm, text, ct, mid in rows:
    body = text if text else linedb.CT.get(ct, f"[type={ct}]")
    info = chats.get(cid)
    if info is None:
        name = linedb.chat_name(con, cid) or cid
        info = {
            "chatId": cid,
            "name": name,
            "isGroup": cid[:1] != "u",
            "messages": [],
        }
        chats[cid] = info
    info["messages"].append({
        "id": mid,
        "time": linedb.iso(t),
        "ts": t,
        "direction": "out" if frm == me else "in",
        "sender": "me" if frm == me else (linedb.chat_name(con, frm) or frm),
        "text": (body or "").strip(),
    })

# order chats by last message time desc
ordered = sorted(chats.values(), key=lambda c: c["messages"][-1]["ts"], reverse=True)

total_msgs = sum(len(c["messages"]) for c in ordered)
result = {
    "window": {"start": START.isoformat(), "end": END.isoformat(),
               "startMs": start_ms, "endMs": end_ms},
    "chatCount": len(ordered),
    "messageCount": total_msgs,
    "chats": ordered,
}

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "eval", "window-messages.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"[+] wrote {out}")
print(f"chats={len(ordered)} messages={total_msgs}")
# directional split
nin = sum(1 for c in ordered for m in c["messages"] if m["direction"] == "in")
nout = total_msgs - nin
print(f"in={nin} out(me)={nout}")
