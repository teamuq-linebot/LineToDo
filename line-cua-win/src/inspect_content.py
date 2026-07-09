#!/usr/bin/env python3
"""Show what the LINE DB actually stores (esp. whether photos are inside it).
Reads the PLAINTEXT line_plain.db via the stdlib sqlite3 (proving it's a normal
SQLite file), then checks on-disk media folders."""
import os, sqlite3, json
import linekey

PLAIN = os.path.join(linekey.REPO_ROOT, "line_plain.db")
CT = {0: "text", 1: "image", 2: "video", 3: "audio", 6: "call/voip",
      7: "sticker", 9: "file?", 13: "contact", 14: "file", 16: "album", 15: "location"}

con = sqlite3.connect(PLAIN)

print("== messages by _contentType ==")
for ct, n in con.execute(
        "SELECT _contentType, count(*) FROM _message GROUP BY _contentType ORDER BY 2 DESC"):
    print(f"  type {ct:>3} ({CT.get(ct,'?'):<8}): {n}")

print("\n== a recent IMAGE message: what columns actually hold ==")
row = con.execute(
    "SELECT _id,_createdTime,_hasContent,length(_text),length(_contentPreview),_contentMetadata "
    "FROM _message WHERE _contentType=1 ORDER BY _createdTime DESC LIMIT 1").fetchone()
if row:
    mid, t, hasc, tlen, plen, meta = row
    print(f"  id={mid}")
    print(f"  _hasContent={hasc}  _text_len={tlen}  _contentPreview_len={plen}")
    print(f"  _contentMetadata={ (meta or '')[:300] }")
else:
    print("  (no image messages found)")

# is the actual image binary stored as a blob anywhere big in _message?
print("\n== largest _contentPreview blobs (thumbnails?) ==")
for mid, ct, n in con.execute(
        "SELECT _id,_contentType,length(_contentPreview) AS L FROM _message "
        "WHERE L IS NOT NULL ORDER BY L DESC LIMIT 5"):
    print(f"  id={mid} type={ct} preview_bytes={n}")

con.close()

print("\n== on-disk LINE data folders (where media really lives) ==")
data = os.path.join(linekey.LOCALAPPDATA, "LINE", "Data")
def dirsize(p):
    total = 0
    for root, _, files in os.walk(p):
        for f in files:
            try: total += os.path.getsize(os.path.join(root, f))
            except OSError: pass
    return total
for name in sorted(os.listdir(data)):
    p = os.path.join(data, name)
    if os.path.isdir(p):
        mb = dirsize(p) / 1024 / 1024
        print(f"  {name:<16} {mb:8.1f} MB")
