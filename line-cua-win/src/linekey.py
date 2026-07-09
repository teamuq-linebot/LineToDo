#!/usr/bin/env python3
"""linekey — recover the LINE-for-Windows DB passphrase.

LINE Desktop (Windows, Qt6) stores history in a wxSQLite3 / QtCipherSqlitePlugin
AES-128-CBC encrypted SQLite DB. Unlike macOS (key in the keychain), Windows
keeps the 32-hex passphrase ONLY in the running LINE.exe process memory (it is
issued by the server at login). We recover it by scanning process memory for
32-hex candidates and confirming by successful decryption — offset-independent,
so it survives LINE updates while LINE is running.

Key resolution order (get_key):
    1. $LINE_DB_KEY
    2. cached <repo>/.linekey
    3. live recovery from LINE.exe memory  (then cached)
"""
import ctypes, ctypes.wintypes as wt, os, re, glob, shutil, tempfile, subprocess

LOCALAPPDATA = os.environ.get("LOCALAPPDATA", "")
DB_DIR = os.path.join(LOCALAPPDATA, "LINE", "Data", "db")
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEYFILE = os.path.join(REPO_ROOT, ".linekey")

CIPHER = "aes128cbc"
KDF_ITER = 1


def find_db():
    """Main message DB = the big qw<hex>.edb with no '_' prefix sibling."""
    cands = [f for f in glob.glob(os.path.join(DB_DIR, "qw*.edb"))
             if "_" not in os.path.basename(f)]
    if not cands:
        return None
    return max(cands, key=os.path.getsize)


def find_pid():
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq LINE.exe", "/FO", "CSV", "/NH"],
        capture_output=True, text=True).stdout
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == "line.exe":
            try:
                return int(parts[1].strip('"'))
            except ValueError:
                pass
    return None


# ---- Win32 process-memory scan ----
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_GUARD = 0x100
PAGE_NOACCESS = 0x01


class _MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wt.DWORD),
        ("__a1", wt.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wt.DWORD),
        ("Protect", wt.DWORD),
        ("Type", wt.DWORD),
        ("__a2", wt.DWORD),
    ]


def _k32():
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.OpenProcess.restype = wt.HANDLE
    k.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    k.VirtualQueryEx.restype = ctypes.c_size_t
    k.VirtualQueryEx.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.POINTER(_MBI), ctypes.c_size_t]
    k.ReadProcessMemory.restype = wt.BOOL
    k.ReadProcessMemory.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                    ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    k.CloseHandle.argtypes = [wt.HANDLE]
    return k


_ASCII_RE = re.compile(rb"(?<![0-9a-fA-F])([0-9a-fA-F]{32})(?![0-9a-fA-F])")
_UTF16_RE = re.compile(rb"(?:[0-9a-fA-F]\x00){32}")


def scan_candidates(pid):
    """Return ordered unique 32-hex strings found in the process's committed memory
    (ASCII and UTF-16LE encodings)."""
    k = _k32()
    h = k.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        raise OSError(f"OpenProcess failed (err={ctypes.get_last_error()})")
    cands = {}
    addr = 0
    mbi = _MBI()
    CHUNK = 4 * 1024 * 1024
    OVERLAP = 80
    buf = ctypes.create_string_buffer(CHUNK)
    nread = ctypes.c_size_t(0)
    try:
        while addr < 0x7FFFFFFFFFFF:
            if k.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
                break
            base = mbi.BaseAddress or addr
            size = mbi.RegionSize
            readable = (mbi.State == MEM_COMMIT and not (mbi.Protect & PAGE_GUARD)
                        and (mbi.Protect & 0xFF) != PAGE_NOACCESS)
            if readable and size:
                off = 0
                while off < size:
                    want = min(CHUNK, size - off)
                    if k.ReadProcessMemory(h, ctypes.c_void_p(base + off), buf, want,
                                           ctypes.byref(nread)) and nread.value:
                        data = buf.raw[:nread.value]
                        for m in _ASCII_RE.finditer(data):
                            cands.setdefault(m.group(1).decode("ascii"), None)
                        for m in _UTF16_RE.finditer(data):
                            cands.setdefault(m.group(0)[::2].decode("ascii"), None)
                    off += want - OVERLAP if want == CHUNK else want
            addr = base + size
    finally:
        k.CloseHandle(h)
    return list(cands.keys())


def _decrypts(db_path, key):
    import apsw
    tmp = tempfile.mkdtemp(prefix="linekey-")
    try:
        dst = os.path.join(tmp, "m.edb")
        shutil.copy2(db_path, dst)
        uri = "file:" + dst.replace("\\", "/") + "?immutable=1"
        con = apsw.Connection(uri, flags=apsw.SQLITE_OPEN_READONLY | apsw.SQLITE_OPEN_URI)
        try:
            con.pragma("cipher", CIPHER)
            con.pragma("kdf_iter", KDF_ITER)
            con.pragma("key", key)
            con.execute("SELECT count(*) FROM sqlite_master").fetchone()
            return True
        except apsw.Error:
            return False
        finally:
            con.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def recover_key(db_path=None, cache=True):
    """Scan LINE.exe memory and return the verified passphrase, or None."""
    db_path = db_path or find_db()
    if not db_path:
        return None
    pid = find_pid()
    if not pid:
        return None
    for key in scan_candidates(pid):
        if _decrypts(db_path, key):
            if cache:
                try:
                    with open(KEYFILE, "w") as f:
                        f.write(key)
                except OSError:
                    pass
            return key
    return None


def get_key(db_path=None):
    """Resolve the key: env -> cache -> live recovery. Verifies a cached key still
    works (LINE re-login rotates it); re-recovers on mismatch."""
    db_path = db_path or find_db()
    env = os.environ.get("LINE_DB_KEY")
    if env:
        return env.strip()
    if os.path.exists(KEYFILE):
        cached = open(KEYFILE).read().strip()
        if cached and db_path and _decrypts(db_path, cached):
            return cached
    return recover_key(db_path)


if __name__ == "__main__":
    import json, sys
    db = find_db()
    pid = find_pid()
    key = get_key(db)
    masked = (key[:6] + "…" + key[-4:]) if key else None
    print(json.dumps({
        "db": db, "linePid": pid, "keyAvailable": bool(key), "key": masked,
    }, ensure_ascii=False, indent=2))
    sys.exit(0 if key else 3)
