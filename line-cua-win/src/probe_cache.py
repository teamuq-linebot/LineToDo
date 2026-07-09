#!/usr/bin/env python3
"""Find where LINE caches media you've VIEWED/DOWNLOADED. If viewing a photo in
LINE leaves a decrypted JPEG/PNG on disk, we can read it directly — no OBS, no
E2EE. Detect by magic bytes (cache files often have hashed, extension-less names)."""
import os, linekey

BASE = os.path.join(linekey.LOCALAPPDATA, "LINE")
MAGIC = {
    b"\xff\xd8\xff": "jpeg", b"\x89PNG": "png", b"GIF8": "gif",
    b"RIFF": "webp/riff", b"\x00\x00\x00": "mp4?(ftyp)",
}

def kind(head):
    for sig, name in MAGIC.items():
        if head.startswith(sig):
            return name
    if head[4:8] == b"ftyp":
        return "mp4/mov"
    return None

# app-asset folders that hold stickers/plugins/UI, not chat media — skip them
SKIP = {"plugin", "Sticker", "Sticon", "resource", "advertisement", "ampkit",
        "ChatEffect", "bgChat", "utsinfo", "AutoSuggest"}

def scan(root, cap=200000):
    found = []  # (path, kind, size, mtime)
    n = 0
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for f in files:
            n += 1
            if n > cap:
                return found, n
            p = os.path.join(dirpath, f)
            try:
                with open(p, "rb") as fh:
                    head = fh.read(12)
                k = kind(head)
                if k:
                    st = os.stat(p)
                    found.append((p, k, st.st_size, st.st_mtime))
            except OSError:
                pass
    return found, n

for sub in ("Cache", "Data"):
    root = os.path.join(BASE, sub)
    if not os.path.isdir(root):
        print(f"== {sub}: (missing) =="); continue
    found, scanned = scan(root)
    imgs = [x for x in found if x[1] in ("jpeg", "png", "gif", "webp/riff")]
    print(f"\n== {sub}: scanned {scanned} files, {len(found)} media-magic, {len(imgs)} images ==")
    from collections import Counter
    c = Counter(x[1] for x in found)
    print("   by kind:", dict(c))
    # show the 8 most-recent images with path + size
    for p, k, sz, mt in sorted(imgs, key=lambda x: x[3], reverse=True)[:8]:
        import datetime
        ts = datetime.datetime.fromtimestamp(mt).strftime("%Y-%m-%d %H:%M")
        rel = os.path.relpath(p, BASE)
        print(f"   {ts}  {sz//1024:>6} KB  {k:<5}  {rel}")
