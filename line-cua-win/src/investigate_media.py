#!/usr/bin/env python3
"""Investigate whether we can fetch real photos. Inspect the auth tokens LINE
stored locally and the image messages' OBS object identifiers, decode them, and
report what an actual download would require. Read-only — does NOT hit network."""
import os, json, base64, sqlite3
import linekey

PLAIN = os.path.join(linekey.REPO_ROOT, "line_plain.db")
con = sqlite3.connect(PLAIN)


def tinfo(table):
    try:
        return [c[1] for c in con.execute(f"PRAGMA table_info({table})")]
    except sqlite3.Error as e:
        return f"ERR {e}"


print("== _channelToken columns ==")
print(" ", tinfo("_channelToken"))
print("== _channelToken rows (values masked) ==")
try:
    for row in con.execute("SELECT * FROM _channelToken LIMIT 20"):
        masked = []
        for v in row:
            s = str(v)
            masked.append(s if len(s) < 14 else s[:8] + "…" + s[-4:])
        print("  ", masked)
except sqlite3.Error as e:
    print("  ERR", e)

# look for any table that smells like auth/session/settings holding a token
print("\n== tables possibly holding auth/session ==")
for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table'"):
    low = name.lower()
    if any(k in low for k in ("token", "auth", "session", "setting", "key", "e2ee", "profile")):
        print(" ", name, tinfo(name))

print("\n== decode a few image OIDs from _contentMetadata ==")
rows = con.execute(
    "SELECT _id,_contentMetadata FROM _message WHERE _contentType=1 "
    "AND _contentMetadata IS NOT NULL ORDER BY _createdTime DESC LIMIT 4").fetchall()
for mid, meta in rows:
    try:
        j = json.loads(meta)
    except Exception:
        j = {}
    oid = j.get("OID", "")
    sid = j.get("SID", "")
    dec = ""
    if oid:
        try:
            pad = oid + "=" * (-len(oid) % 4)
            dec = base64.urlsafe_b64decode(pad).decode("utf-8", "replace")
        except Exception as e:
            dec = f"(decode err {e})"
    print(f"  id={mid} SID={sid!r} OID={oid[:24]}…")
    print(f"     OID decoded -> {dec}")
    print(f"     other keys  -> {[k for k in j.keys() if k not in ('OID','SID')]}")

# does any message store a direct URL?
print("\n== sample _contentMetadata for non-image media (file/video) ==")
for ct in (2, 14):
    r = con.execute("SELECT _contentMetadata FROM _message WHERE _contentType=? "
                    "AND _contentMetadata IS NOT NULL ORDER BY _createdTime DESC LIMIT 1",
                    (ct,)).fetchone()
    if r:
        print(f"  type {ct}: {(r[0] or '')[:260]}")

con.close()
