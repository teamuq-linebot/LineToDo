#!/usr/bin/env python3
"""watch — monitor LINE for NEW messages by polling the decrypted local DB.

Pure read: copies + decrypts only when LINE's DB actually changed (cheap stat
gate on the -wal file), then reports messages newer than the last checkpoint.
No UI, no network, no account risk.

  watch.py --demo               # print the 5 newest messages (verify it reads)
  watch.py --reset-now          # set checkpoint = now (start fresh)
  watch.py --once               # one poll: print messages since checkpoint
  watch.py --follow --interval 15 [--name "Alice"]   # loop forever
"""
import sys, os, json, time, argparse
import linedb, linekey

STATE = os.path.join(linekey.REPO_ROOT, ".watch_state")
SRC = linekey.find_db()


def wal_sig():
    sig = {}
    for ext in ("", "-wal"):
        p = (SRC or "") + ext
        try:
            st = os.stat(p); sig[ext or "edb"] = (st.st_size, int(st.st_mtime_ns))
        except OSError:
            sig[ext or "edb"] = None
    return sig


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"last_ts": 0, "sig": None}


def save_state(s):
    json.dump(s, open(STATE, "w"))


def new_messages(con, since_ts, name=None):
    cid = linedb.resolve_chat(con, name) if name else None
    q = ("SELECT _chatId,_createdTime,_from,_text,_contentType,_id FROM _message "
         "WHERE _createdTime > ?")
    args = [since_ts]
    if cid:
        q += " AND _chatId=?"; args.append(cid)
    q += " ORDER BY _createdTime"
    me = linedb.my_mid(con)
    out = []
    for c, t, frm, text, ct, mid in con.execute(q, args).fetchall():
        body = text if text else (linedb.CT.get(ct) or f"[type={ct}]")
        out.append({
            "chat": linedb.chat_name(con, c) or c, "time": linedb.iso(t), "ts": t,
            "direction": "out" if frm == me else "in",
            "sender": "me" if frm == me else (linedb.chat_name(con, frm) or frm),
            "text": body,
        })
    return out


def fmt(m):
    arrow = "→" if m["direction"] == "out" else "←"
    return f"  {m['time'][11:16]} {arrow} [{m['chat']}] {m['sender']}: {m['text']}"


def poll(name=None, verbose=True):
    """Return new messages since checkpoint; updates checkpoint. Stat-gated."""
    s = load_state()
    sig = wal_sig()
    if s.get("sig") == sig and s.get("last_ts"):
        return []  # nothing changed on disk -> skip the 200MB copy
    con = linedb.open_db()
    msgs = new_messages(con, s.get("last_ts", 0), name)
    if msgs:
        s["last_ts"] = max(m["ts"] for m in msgs)
    elif not s.get("last_ts"):
        row = con.execute("SELECT MAX(_createdTime) FROM _message").fetchone()
        s["last_ts"] = row[0] or 0
    s["sig"] = sig
    save_state(s)
    return msgs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--reset-now", action="store_true")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--follow", action="store_true")
    ap.add_argument("--interval", type=int, default=15)
    ap.add_argument("--name")
    a = ap.parse_args()

    if a.demo:
        con = linedb.open_db()
        me = linedb.my_mid(con)
        rows = con.execute(
            "SELECT _chatId,_createdTime,_from,_text,_contentType FROM _message "
            "ORDER BY _createdTime DESC LIMIT 5").fetchall()
        print("[*] 5 newest messages across all chats:")
        for c, t, frm, text, ct in rows:
            body = text if text else (linedb.CT.get(ct) or f"[type={ct}]")
            who = "me" if frm == me else (linedb.chat_name(con, frm) or frm)
            print(fmt({"time": linedb.iso(t), "direction": "out" if frm == me else "in",
                       "chat": linedb.chat_name(con, c) or c, "sender": who, "text": body}))
        return

    if a.reset_now:
        con = linedb.open_db()
        ts = con.execute("SELECT MAX(_createdTime) FROM _message").fetchone()[0] or 0
        save_state({"last_ts": ts, "sig": wal_sig()})
        print(f"[*] checkpoint set to now (ts={ts}). future new messages will be reported.")
        return

    if a.follow:
        print(f"[*] watching every {a.interval}s" + (f" (chat: {a.name})" if a.name else "")
              + " — Ctrl+C to stop")
        while True:
            for m in poll(a.name, verbose=False):
                print(fmt(m), flush=True)
            time.sleep(a.interval)
    else:  # --once (default)
        msgs = poll(a.name)
        if not msgs:
            print("[*] no new messages since last checkpoint.")
        for m in msgs:
            print(fmt(m))


if __name__ == "__main__":
    main()
