#!/usr/bin/env python3
# linedb.py — read LINE-for-Windows's encrypted local message DB fully offline.
#
# Windows port of the original macOS reader. LINE Desktop (Windows, Qt6) stores
# all history in a wxSQLite3 / QtCipherSqlitePlugin AES-128-CBC encrypted SQLite
# file (NOT SQLCipher) at %LOCALAPPDATA%\LINE\Data\db\qw<hex>.edb. Given the
# account's 32-hex key (recovered from LINE.exe memory — see linekey.py), the
# whole history is readable with zero UI: no cursor, no foreground, no OCR.
#
# Decryption: apsw-sqlite3mc, PRAGMA cipher='aes128cbc', kdf_iter=1. We snapshot
# the DB (+ -wal/-shm) to a temp dir and open the COPY read-write so the WAL is
# merged (latest messages visible) without ever perturbing LINE's live files.
#
# CLI:  linedb.py status
#       linedb.py list-chats [--limit N]
#       linedb.py read <chat-name-or-id> [--limit N]
#       linedb.py coverage <chat-name-or-id>
#       linedb.py search <text> [--limit N]
import sys, os, re, json, shutil, tempfile, datetime, argparse, atexit
from zoneinfo import ZoneInfo

try:
    import apsw
except Exception as e:  # pragma: no cover
    print(json.dumps({"error": f"apsw-sqlite3mc not installed: {e}"})); sys.exit(2)

import linekey  # sibling module: find_db / get_key / cipher params


def open_db():
    src = linekey.find_db()
    if not src:
        raise SystemExit(json.dumps({"error": "LINE message DB not found", "dir": linekey.DB_DIR}))
    key = linekey.get_key(src)
    if not key:
        raise SystemExit(json.dumps({"error": "DB key unavailable",
            "hint": "open LINE (key is read from its memory), or set $LINE_DB_KEY"}))
    tmp = tempfile.mkdtemp(prefix="linedb-")
    atexit.register(lambda: shutil.rmtree(tmp, ignore_errors=True))
    path = os.path.join(tmp, "m.edb")
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(src + ext):
            shutil.copy2(src + ext, path + ext)
    # open the COPY read-write so the WAL merges in (latest messages visible)
    con = apsw.Connection(path)
    con.pragma("cipher", linekey.CIPHER)
    con.pragma("kdf_iter", linekey.KDF_ITER)
    con.pragma("key", key)
    try:
        con.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except apsw.Error:
        raise SystemExit(json.dumps({"error": "decryption failed — wrong key or cipher params"}))
    try:
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except apsw.Error:
        pass
    return con


def my_mid(con):
    r = con.execute("SELECT _mid FROM _profile LIMIT 1").fetchone()
    return r[0] if r else None


def chat_name(con, chat_id):
    """Resolve a chatId/mid to a display name across 1:1 / group / community."""
    g = con.execute("SELECT _chatName FROM _groupChat WHERE _chatMid=?", (chat_id,)).fetchone()
    if g and g[0]:
        return g[0]
    try:
        sq = con.execute("SELECT _name FROM _square WHERE _mid=?", (chat_id,)).fetchone()
        if sq and sq[0]:
            return sq[0]
    except apsw.SQLError:
        pass
    ct = con.execute(
        "SELECT _displayNameOverridden,_displayName,_targetProfileDetail FROM _contact WHERE _mid=?",
        (chat_id,),
    ).fetchone()
    if ct:
        if ct[0]:
            return ct[0]
        if ct[1]:
            return ct[1]
        if ct[2]:
            try:
                pn = json.loads(ct[2]).get("profileName")
                if pn:
                    return pn
            except Exception:
                pass
    return None


def list_chats(con, limit=50):
    out = []
    for cid, lut, last in con.execute(
        "SELECT _id,_lastUpdatedTime,_lastMessage FROM _chat ORDER BY _lastUpdatedTime DESC LIMIT ?",
        (limit,),
    ):
        out.append({
            "chatId": cid,
            "name": chat_name(con, cid),
            "lastUpdated": iso(lut),
            # 1:1 contacts are "u"-prefixed; treat everything else (groups "c",
            # rooms "m", LINE Square "t", unknown) as a group so the send guard
            # fails CLOSED on unknown chat types.
            "isGroup": cid[:1] != "u",
        })
    return out


def resolve_chat(con, name):
    """name -> chatId. Accepts a raw chatId, exact name, or unambiguous substring."""
    if con.execute("SELECT 1 FROM _chat WHERE _id=? LIMIT 1", (name,)).fetchone():
        return name
    chats = list_chats(con, 5000)
    exact = [c for c in chats if c["name"] == name]
    if len(exact) == 1:
        return exact[0]["chatId"]
    if len(exact) > 1:
        raise SystemExit(json.dumps({"error": "ambiguous exact name",
            "matches": [c["name"] for c in exact]}, ensure_ascii=False))
    fuzzy = [c for c in chats if c["name"] and name in c["name"]]
    if len(fuzzy) == 1:
        return fuzzy[0]["chatId"]
    if len(fuzzy) > 1:
        raise SystemExit(json.dumps({"error": "ambiguous name",
            "matches": [c["name"] for c in fuzzy[:20]]}, ensure_ascii=False))
    raise SystemExit(json.dumps({"error": f"no chat named '{name}'"}, ensure_ascii=False))


# LINE message _contentType -> label for non-text messages
CT = {0: None, 1: "[image]", 2: "[video]", 3: "[audio]", 7: "[sticker]",
      6: "[call]", 13: "[contact]", 14: "[file]", 16: "[album]"}


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000).isoformat(timespec="seconds") if ms else None


def read_history(con, chat_id, limit=0):
    me = my_mid(con)
    rows = con.execute(
        "SELECT _createdTime,_from,_text,_contentType,_id FROM _message "
        "WHERE _chatId=? ORDER BY _createdTime", (chat_id,)
    ).fetchall()
    if limit and limit > 0:
        rows = rows[-limit:]
    msgs = []
    for t, frm, text, ct, mid in rows:
        body = text if text else CT.get(ct, f"[type={ct}]")
        msgs.append({
            "id": mid, "time": iso(t), "ts": t,
            "direction": "out" if frm == me else "in",
            "sender": "me" if frm == me else (chat_name(con, frm) or frm),
            "text": body,
        })
    return msgs


def chat_coverage(con, chat_id):
    row = con.execute(
        "SELECT COUNT(*), MIN(_createdTime), MAX(_createdTime) "
        "FROM _message WHERE _chatId=?", (chat_id,)
    ).fetchone()
    total = row[0] if row else 0
    oldest = row[1] if row and row[1] is not None else None
    newest = row[2] if row and row[2] is not None else None
    return {
        "source": "local-line-desktop-db",
        "localMessageCount": total,
        "oldestLocalMessage": iso(oldest),
        "oldestLocalMessageTs": oldest,
        "newestLocalMessage": iso(newest),
        "newestLocalMessageTs": newest,
        "mayExcludeRemoteUnsyncedHistory": True,
    }


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    p = sub.add_parser("list-chats"); p.add_argument("--limit", type=int, default=50)
    p = sub.add_parser("read"); p.add_argument("name"); p.add_argument("--limit", type=int, default=0)
    p = sub.add_parser("coverage"); p.add_argument("name")
    p = sub.add_parser("search"); p.add_argument("text"); p.add_argument("--limit", type=int, default=50)
    a = ap.parse_args()

    if a.cmd == "status":
        src = linekey.find_db()
        key = linekey.get_key(src) if src else None
        out = {"db": src, "dbFound": bool(src), "linePid": linekey.find_pid(),
               "keyAvailable": bool(key)}
        if src and key:
            try:
                con = open_db()
                out["decryptOk"] = True
                out["messageCount"] = con.execute("SELECT count(*) FROM _message").fetchone()[0]
                out["chatCount"] = con.execute("SELECT count(*) FROM _chat").fetchone()[0]
            except SystemExit as e:
                out["decryptOk"] = False; out["detail"] = str(e)
        print(json.dumps(out, ensure_ascii=False, indent=2)); return

    con = open_db()
    if a.cmd == "list-chats":
        print(json.dumps(list_chats(con, a.limit), ensure_ascii=False, indent=2))
    elif a.cmd == "read":
        cid = resolve_chat(con, a.name)
        msgs = read_history(con, cid, a.limit)
        cov = chat_coverage(con, cid)
        cov["returnedMessageCount"] = len(msgs)
        cov["limitApplied"] = bool(a.limit and a.limit > 0)
        print(json.dumps({"chatId": cid, "name": chat_name(con, cid),
                          "messages": msgs, "coverage": cov},
                         ensure_ascii=False, indent=2))
    elif a.cmd == "coverage":
        cid = resolve_chat(con, a.name)
        print(json.dumps({"chatId": cid, "name": chat_name(con, cid),
                          **chat_coverage(con, cid)}, ensure_ascii=False, indent=2))
    elif a.cmd == "search":
        me = my_mid(con)
        rows = con.execute(
            "SELECT _chatId,_createdTime,_from,_text FROM _message "
            "WHERE _text LIKE ? ORDER BY _createdTime DESC LIMIT ?",
            (f"%{a.text}%", a.limit)).fetchall()
        res = [{"chatId": c, "chat": chat_name(con, c), "time": iso(t),
                "direction": "out" if f == me else "in", "text": tx}
               for c, t, f, tx in rows]
        print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
