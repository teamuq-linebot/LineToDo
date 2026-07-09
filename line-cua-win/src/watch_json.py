#!/usr/bin/env python3
"""watch_json — NDJSON edition of watch.py for the line-todo Electron app.

Pure addition (does NOT touch watch.py). Reuses linedb / linekey to read NEW
LINE messages since a checkpoint and emits ONE JSON object per line (NDJSON) to
stdout, with the field contract the line-todo App expects (chat, chatId,
isGroup, ts, time, direction, sender, text, contentType).

Why a separate script + separate checkpoint:
  watch.py's .watch_state checkpoint is owned by the human-readable CLI. If this
  App shared it, the two consumers would eat each other's "new messages". So we
  keep an INDEPENDENT checkpoint file <REPO_ROOT>/.watch_json_state.

Stat-gate: same cheap (size, mtime_ns) gate on the edb/-wal as watch.py, so when
LINE's DB hasn't changed we emit 0 lines and skip the ~200MB decrypt+copy.

  watch_json.py --once            # default: messages since checkpoint, NDJSON
  watch_json.py --follow --interval 15   # loop forever, NDJSON per new message
  watch_json.py --reset-now       # checkpoint = newest message (start fresh)
  watch_json.py --since <ms>      # ignore checkpoint, _createdTime > ms (debug)
  watch_json.py --limit <N>       # safety cap per poll (default 500)
  watch_json.py --name "<chat>"   # restrict to one chat

  --json is accepted (no-op) for CLI symmetry with watch.py; NDJSON is the
  default and only output mode here.

Errors (key/decrypt/db missing): emit ONE line {"error": "..."} to STDERR and
exit 2. stdout never carries error objects, so the consumer can parse stdout
strictly as NDJSON.
"""
import sys, os, io, json, time, argparse

# Force UTF-8 on Windows regardless of console code page, so 中文 survives the
# pipe to the Electron parent. (watcher.ts also sets PYTHONUTF8/PYTHONIOENCODING,
# this is belt-and-suspenders for direct CLI runs.)
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    # Older Python without reconfigure: wrap the buffers.
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

import linedb, linekey

STATE = os.path.join(linekey.REPO_ROOT, ".watch_json_state")
SRC = linekey.find_db()


def _err(msg):
    """Emit a single error line to stderr, exit 2. stdout stays clean."""
    print(json.dumps({"error": str(msg)}, ensure_ascii=False), file=sys.stderr, flush=True)
    sys.exit(2)


def wal_sig():
    """(size, mtime_ns) of edb + -wal — cheap 'did LINE's DB change?' gate."""
    sig = {}
    for ext in ("", "-wal"):
        p = (SRC or "") + ext
        try:
            st = os.stat(p)
            sig[ext or "edb"] = (st.st_size, int(st.st_mtime_ns))
        except OSError:
            sig[ext or "edb"] = None
    return sig


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {"last_ts": 0, "sig": None}


def save_state(s):
    try:
        with open(STATE, "w") as f:
            json.dump(s, f)
    except OSError:
        pass  # non-fatal; worst case we re-report some messages next run


def _media_fields(cmeta_raw, cinfo_raw, ct, text):
    """E2EE media fields for line-todo to locate + decrypt the local .eimg.

    Gate (Phase 0): only contentType 1 (image) / 14 (file) whose _contentInfo
    carries a non-empty keyMaterial (== e2eeMark==2, the decryptable media) get
    real values. Public videos, unsent messages and empty-metadata rows all fall
    through to null, so the App never tries to decrypt what it can't. JSON parsing
    is fully tolerant — a missing column or malformed JSON just yields null and
    never crashes the watcher. keyMaterial is passed through only, NEVER logged.
    """
    null = {"keyMaterial": None, "fileName": None, "fileSize": None,
            "oid": None, "sid": None}
    if ct not in (1, 14):
        return null
    try:
        info = json.loads(cinfo_raw) if cinfo_raw else None
    except (ValueError, TypeError):
        info = None
    if not isinstance(info, dict):
        return null
    key_material = info.get("keyMaterial")
    if not key_material:
        return null  # non-E2EE / undecryptable -> stay null (Phase 0 gate)
    try:
        meta = json.loads(cmeta_raw) if cmeta_raw else None
    except (ValueError, TypeError):
        meta = None
    if not isinstance(meta, dict):
        meta = {}
    # fileName: files only (ct=14); _contentInfo.fileName first, else _text.
    # Images have no original name. Never read _contentMetadata.FILE_NAME (empty).
    file_name = (info.get("fileName") or (text or None)) if ct == 14 else None
    # fileSize: _contentMetadata.FILE_SIZE — UPPERCASE, stored as a string.
    file_size = None
    raw_size = meta.get("FILE_SIZE")
    if raw_size is not None:
        try:
            file_size = int(raw_size)
        except (ValueError, TypeError):
            file_size = None
    return {
        "keyMaterial": key_material,
        "fileName": file_name,
        "fileSize": file_size,
        "oid": meta.get("OID"),
        "sid": meta.get("SID"),
    }


_CALL_CAUSE = {
    17: "📞 忙線未接",
    18: "📞 未接來電",
    21: "📞 已拒接",
    77: "📞 已取消通話",
    127: "📞 通話失敗",
}


def _fmt_call_duration(ms):
    """DURATION (ms) -> human label. <60s: 'N 秒'; >=60s: 'M 分 S 秒'."""
    secs = round(ms / 1000)
    if ms < 60000:
        return f"{secs} 秒"
    return f"{secs // 60} 分 {secs % 60} 秒"


def _call_label(cmeta_raw):
    """ct=6 call -> pretty label from _contentMetadata TYPE/DURATION/CAUSE.

    Returns None when metadata is missing/malformed or CAUSE is unusable, so
    row_to_obj falls back to the original _text/CT behavior. Fully tolerant:
    bad JSON / missing keys just yield None and never crash the watcher.
    """
    try:
        meta = json.loads(cmeta_raw) if cmeta_raw else None
    except (ValueError, TypeError):
        meta = None
    if not isinstance(meta, dict):
        return None
    typ = meta.get("TYPE")
    if typ == "G":
        return "👥 群組通話"
    icon = "📹" if typ == "V" else "📞"
    kind = "視訊" if typ == "V" else "語音"
    try:
        cause = int(meta.get("CAUSE"))
    except (ValueError, TypeError):
        return None  # missing/garbage CAUSE -> fall back to original _text
    if cause == 16:
        try:
            dur = int(meta.get("DURATION"))
        except (ValueError, TypeError):
            dur = 0
        if dur > 0:
            return f"{icon} {kind}通話・{_fmt_call_duration(dur)}"
        return "📞 通話"
    if cause in _CALL_CAUSE:
        return _CALL_CAUSE[cause]
    return "📞 通話"  # known-int but unrecognized CAUSE


def row_to_obj(con, me, c, t, frm, text, ct, mid, cmeta=None, cinfo=None, attribute=None):
    """One _message row -> the App's NDJSON contract dict."""
    if ct == 6:
        body = _call_label(cmeta) or (text if text else (linedb.CT.get(ct) or f"[type={ct}]"))
    else:
        body = text if text else (linedb.CT.get(ct) or f"[type={ct}]")
    direction = "out" if frm == me else "in"
    media = _media_fields(cmeta, cinfo, ct, text)
    return {
        # LINE's native _message._id — globally-unique message id. The App uses
        # this as the real dedupe key (messages.msg_id PK) so that messages
        # sharing the same (chatId, ts, direction, sender, text) — e.g. several
        # images posted in the same second whose text all collapse to "[image]"
        # — are NOT collapsed into one by a hash collision. read_history already
        # exposes this (as "id"); we just hadn't propagated it here.
        # May be None on rare rows with no _id; App falls back to a hash then.
        "msgId": str(mid) if mid is not None else None,
        "chat": linedb.chat_name(con, c) or c,
        "chatId": c,
        # 1:1 contacts are "u"-prefixed; everything else (group "c", room "m",
        # Square "t", unknown) -> group. Same fail-closed rule as list_chats.
        "isGroup": (c[:1] != "u") if c else True,
        "ts": t,
        "time": linedb.iso(t),
        "direction": direction,
        "sender": "me" if direction == "out" else (linedb.chat_name(con, frm) or frm),
        "text": body,
        "contentType": ct if ct is not None else 0,
        # 已收回旗標；_attribute==1 與 UNSENT 全庫 1:1。None/非數字 -> False（不 crash）。
        "unsent": attribute == 1,
        # E2EE media fields — null unless ct∈{1,14} with a keyMaterial present.
        # line-todo uses these to locate + decrypt the local .eimg. keyMaterial is
        # passed through here only; it is NEVER logged.
        **media,
    }


def new_messages(con, since_ts, name=None, limit=500):
    cid = linedb.resolve_chat(con, name) if name else None
    q = ("SELECT _chatId,_createdTime,_from,_text,_contentType,_id,"
         "_contentMetadata,_contentInfo,_attribute FROM _message "
         "WHERE _createdTime > ?")
    args = [since_ts]
    if cid:
        q += " AND _chatId=?"
        args.append(cid)
    q += " ORDER BY _createdTime LIMIT ?"
    args.append(limit)
    me = linedb.my_mid(con)
    out = []
    for c, t, frm, text, ct, mid, cmeta, cinfo, attribute in con.execute(q, args).fetchall():
        out.append(row_to_obj(con, me, c, t, frm, text, ct, mid, cmeta, cinfo, attribute))
    return out


def emit(msgs):
    for m in msgs:
        sys.stdout.write(json.dumps(m, ensure_ascii=False) + "\n")
    if msgs:
        sys.stdout.flush()


def poll(name=None, limit=500):
    """Return + emit new messages since checkpoint; update checkpoint. Stat-gated.

    Returns the list (already emitted) so --follow can keep looping.
    """
    s = load_state()
    sig = wal_sig()
    if s.get("sig") == sig and s.get("last_ts"):
        return []  # disk unchanged -> skip the expensive decrypt/copy
    con = linedb.open_db()
    msgs = new_messages(con, s.get("last_ts", 0), name, limit)
    emit(msgs)
    if msgs:
        s["last_ts"] = max(m["ts"] for m in msgs)
    elif not s.get("last_ts"):
        row = con.execute("SELECT MAX(_createdTime) FROM _message").fetchone()
        s["last_ts"] = (row[0] if row else 0) or 0
    s["sig"] = sig
    save_state(s)
    return msgs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true",
                    help="accepted for symmetry with watch.py; NDJSON is the default here")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--follow", action="store_true")
    ap.add_argument("--reset-now", action="store_true")
    ap.add_argument("--since", type=int, default=None,
                    help="ignore checkpoint; report _createdTime > this epoch-ms")
    ap.add_argument("--interval", type=int, default=15)
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--name")
    a = ap.parse_args()

    try:
        if a.reset_now:
            con = linedb.open_db()
            row = con.execute("SELECT MAX(_createdTime) FROM _message").fetchone()
            ts = (row[0] if row else 0) or 0
            save_state({"last_ts": ts, "sig": wal_sig()})
            # status line to stderr so stdout stays pure NDJSON
            print(json.dumps({"event": "reset", "last_ts": ts}, ensure_ascii=False),
                  file=sys.stderr, flush=True)
            return

        if a.since is not None:
            # Debug/backfill: bypass checkpoint entirely, don't mutate state.
            con = linedb.open_db()
            emit(new_messages(con, a.since, a.name, a.limit))
            return

        if a.follow:
            # Loop forever. Each poll is stat-gated and emits NDJSON as it goes.
            while True:
                poll(a.name, a.limit)
                time.sleep(a.interval)
        else:  # --once (default)
            poll(a.name, a.limit)

    except SystemExit as e:
        # linedb/linekey raise SystemExit(json_str) on key/decrypt/db failure.
        # Re-shape onto stderr as a single error line, exit 2.
        code = e.code
        if isinstance(code, int):
            raise
        raw = code if code else "unknown error"
        # linedb's code is usually already a JSON string like {"error": "..."}.
        # Unwrap it so we emit one clean {"error": ...} object, not nested JSON.
        try:
            parsed = json.loads(raw)
            obj = parsed if isinstance(parsed, dict) and "error" in parsed else {"error": str(raw)}
        except (ValueError, TypeError):
            obj = {"error": str(raw)}
        print(json.dumps(obj, ensure_ascii=False), file=sys.stderr, flush=True)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as e:
        _err(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
