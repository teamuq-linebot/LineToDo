#!/usr/bin/env python3
"""media_cache — pull photos out of LINE's local cache.

When you view (or scroll past) a photo in LINE, it decrypts it to
%LOCALAPPDATA%\\LINE\\Cache as a plain JPEG/PNG (hashed name, often no extension).
This reads those out — no OBS, no E2EE, no account risk.

  media_cache.py --list 10                 # newest 10 cached images
  media_cache.py --export 10 --out DIR      # copy newest 10 out, named by time
  media_cache.py --watch --out DIR          # auto-copy each new image as it appears
                                            # (open a photo in LINE -> it pops out)
"""
import os, sys, time, shutil, argparse, datetime
import linekey

CACHE = os.path.join(linekey.LOCALAPPDATA, "LINE", "Cache")
SKIP = {"plugin", "Sticker", "Sticon", "resource"}
EXT = {b"\xff\xd8\xff": ".jpg", b"\x89PNG": ".png", b"GIF8": ".gif"}


def kind(head):
    for sig, ext in EXT.items():
        if head.startswith(sig):
            return ext
    return None


def images(since_mtime=0):
    out = []
    for dp, dirs, files in os.walk(CACHE):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for f in files:
            p = os.path.join(dp, f)
            try:
                st = os.stat(p)
                if st.st_mtime <= since_mtime or st.st_size < 1024:
                    continue
                with open(p, "rb") as fh:
                    ext = kind(fh.read(8))
                if ext:
                    out.append((p, ext, st.st_size, st.st_mtime))
            except OSError:
                pass
    out.sort(key=lambda x: x[3], reverse=True)
    return out


def nice(mt):
    return datetime.datetime.fromtimestamp(mt).strftime("%Y-%m-%d_%H%M%S")


def copy_out(items, outdir):
    os.makedirs(outdir, exist_ok=True)
    written = []
    for p, ext, sz, mt in items:
        name = f"{nice(mt)}_{os.path.basename(p)[:10]}{ext}"
        dst = os.path.join(outdir, name)
        if not os.path.exists(dst):
            shutil.copy2(p, dst); written.append(dst)
    return written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", type=int, metavar="N")
    ap.add_argument("--export", type=int, metavar="N")
    ap.add_argument("--out")
    ap.add_argument("--watch", action="store_true")
    ap.add_argument("--interval", type=int, default=5)
    a = ap.parse_args()

    if not os.path.isdir(CACHE):
        raise SystemExit(f"cache not found: {CACHE}")

    if a.watch:
        outdir = a.out or os.path.join(linekey.REPO_ROOT, "line_photos")
        last = time.time()
        print(f"[*] watching {CACHE}\n    new photos -> {outdir}\n    open a photo in LINE; Ctrl+C to stop")
        while True:
            new = [x for x in images(since_mtime=last) ]
            if new:
                for d in copy_out(new, outdir):
                    print(f"  + {d}", flush=True)
                last = max(x[3] for x in new)
            time.sleep(a.interval)
        return

    items = images()
    n = a.list or a.export or 10
    sel = items[:n]
    if a.export:
        outdir = a.out or os.path.join(linekey.REPO_ROOT, "line_photos")
        for d in copy_out(sel, outdir):
            print(f"  + {d}")
        print(f"[+] exported {len(sel)} image(s) to {outdir}")
    else:
        print(f"[*] {len(items)} cached images total; newest {len(sel)}:")
        for p, ext, sz, mt in sel:
            print(f"  {nice(mt)}  {sz//1024:>6} KB  {ext}  {os.path.relpath(p, CACHE)}")


if __name__ == "__main__":
    main()
