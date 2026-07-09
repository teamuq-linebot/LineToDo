#!/usr/bin/env python3
"""Decrypt LINE's encrypted message DB into a PLAINTEXT SQLite file that any tool
(DBeaver, sqlite3, DB Browser, ...) can open with no special driver.

Output: <repo>/line_plain.db   (or pass a path as argv[1])

NOTE: the output is your full chat history in CLEARTEXT. Keep it private; delete
it when done. It is .gitignore'd.
"""
import os, sys, shutil, tempfile, apsw
import linekey


def main():
    src = linekey.find_db()
    if not src:
        raise SystemExit("LINE DB not found")
    key = linekey.get_key(src)
    if not key:
        raise SystemExit("DB key unavailable — open LINE so the key can be captured")

    out = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 \
        else os.path.join(linekey.REPO_ROOT, "line_plain.db")

    # snapshot (main + wal + shm) so we never touch LINE's live files
    tmp = tempfile.mkdtemp(prefix="linedec-")
    try:
        snap = os.path.join(tmp, "m.edb")
        for ext in ("", "-wal", "-shm"):
            if os.path.exists(src + ext):
                shutil.copy2(src + ext, snap + ext)
        enc = apsw.Connection(snap)
        enc.pragma("cipher", linekey.CIPHER)
        enc.pragma("kdf_iter", linekey.KDF_ITER)
        enc.pragma("key", key)
        enc.execute("SELECT count(*) FROM sqlite_master").fetchone()  # verify key
        try:
            enc.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except apsw.Error:
            pass
        enc.execute("PRAGMA journal_mode=DELETE")  # write changes to main file
        enc.pragma("rekey", "")                    # remove encryption in place
        enc.execute("SELECT count(*) FROM _message").fetchone()  # readable as plaintext now
        enc.close()

        for ext in ("", "-wal", "-shm"):
            if os.path.exists(out + ext):
                os.remove(out + ext)
        shutil.copy2(snap, out)                    # snap is now a plaintext SQLite file
        import sqlite3
        chk = sqlite3.connect(out)
        n = chk.execute("SELECT count(*) FROM _message").fetchone()[0]
        chk.close()
        print(f"[+] wrote {out}  ({os.path.getsize(out)//1024//1024} MB, {n} messages)")
        print("    open this file directly in DBeaver (SQLite driver, no password).")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
