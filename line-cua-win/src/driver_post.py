#!/usr/bin/env python3
"""driver_post — experimental BACKGROUND driver for LINE via Win32 messages.

Goal: operate LINE without foregrounding it or moving the real cursor (OBS / your
active window stay put) — the Windows analog of macOS's cursor-free send.

 - input  : PostMessage WM_LBUTTONDOWN/UP + WM_CHAR to LINE's HWND (client coords)
 - verify : PrintWindow (PW_RENDERFULLCONTENT) captures LINE even when occluded

Whether Qt (LINE) honors synthesized messages without real focus is unknown — this
script is the feasibility test. CLI:
    driver_post.py cap                 # PrintWindow-capture LINE -> _calib/post_cap.png
    driver_post.py probe-type TEXT     # click search box + type TEXT (no send), capture
"""
import os, sys, time, ctypes
from ctypes import wintypes
from PIL import Image
import uiautomation as auto
import linekey

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
for f, res, args in [
    (user32.GetWindowDC, ctypes.c_void_p, [wintypes.HWND]),
    (user32.ReleaseDC, ctypes.c_int, [wintypes.HWND, ctypes.c_void_p]),
    (user32.GetWindowThreadProcessId, wintypes.DWORD, [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]),
    (user32.IsWindowVisible, wintypes.BOOL, [wintypes.HWND]),
    (user32.PrintWindow, wintypes.BOOL, [wintypes.HWND, ctypes.c_void_p, wintypes.UINT]),
    (user32.PostMessageW, wintypes.BOOL, [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]),
    (gdi32.CreateCompatibleDC, ctypes.c_void_p, [ctypes.c_void_p]),
    (gdi32.CreateCompatibleBitmap, ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]),
    (gdi32.SelectObject, ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_void_p]),
    (gdi32.DeleteObject, wintypes.BOOL, [ctypes.c_void_p]),
    (gdi32.DeleteDC, wintypes.BOOL, [ctypes.c_void_p]),
    (gdi32.GetDIBits, ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT, wintypes.UINT,
                                     ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]),
    (user32.GetWindowRect, wintypes.BOOL, [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]),
    (user32.GetClassNameW, ctypes.c_int, [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]),
    (user32.ScreenToClient, wintypes.BOOL, [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]),
    (user32.ShowWindow, wintypes.BOOL, [wintypes.HWND, ctypes.c_int]),
    (user32.SetForegroundWindow, wintypes.BOOL, [wintypes.HWND]),
]:
    f.restype = res; f.argtypes = args

WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP = 0x0200, 0x0201, 0x0202
WM_CHAR, WM_KEYDOWN, WM_KEYUP = 0x0102, 0x0100, 0x0101
MK_LBUTTON = 0x0001
VK_RETURN = 0x0D

class BMIH(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPPM", wintypes.LONG), ("biYPPM", wintypes.LONG),
                ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


def enum_pid_windows(pid):
    out = []
    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h, _):
        p = wintypes.DWORD()
        user32.GetWindowThreadProcessId(h, ctypes.byref(p))
        if p.value == pid:
            buf = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(h, buf, 256)
            l, t, r, b = win_rect(h)
            out.append({"hwnd": h, "class": buf.value, "visible": bool(user32.IsWindowVisible(h)),
                        "rect": (l, t, r, b), "area": (r - l) * (b - t)})
        return True
    user32.EnumWindows(cb, 0)
    return out


def get_hwnd():
    pid = linekey.find_pid()
    if not pid:
        raise SystemExit("LINE.exe not running")
    wins = [w for w in enum_pid_windows(pid) if w["visible"] and w["area"] > 100000]
    if not wins:
        return None
    return max(wins, key=lambda w: w["area"])["hwnd"]


def win_rect(hwnd):
    r = wintypes.RECT(); user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def capture(hwnd):
    l, t, r, b = win_rect(hwnd)
    w, h = r - l, b - t
    hdc = user32.GetWindowDC(hwnd)
    memdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(memdc, bmp)
    ok = user32.PrintWindow(hwnd, memdc, 2)  # PW_RENDERFULLCONTENT
    bmi = BMIH(); bmi.biSize = ctypes.sizeof(BMIH); bmi.biWidth = w; bmi.biHeight = -h
    bmi.biPlanes = 1; bmi.biBitCount = 32; bmi.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(memdc, bmp, 0, h, buf, ctypes.byref(bmi), 0)
    img = Image.frombuffer("RGB", (w, h), buf.raw, "raw", "BGRX", 0, 1)
    gdi32.DeleteObject(bmp); gdi32.DeleteDC(memdc); user32.ReleaseDC(hwnd, hdc)
    return img, bool(ok), (l, t)


def screen_to_client(hwnd, sx, sy):
    pt = wintypes.POINT(sx, sy)
    user32.ScreenToClient(hwnd, ctypes.byref(pt))
    return pt.x, pt.y


def lparam(x, y):
    return (y << 16) | (x & 0xFFFF)


def post_click(hwnd, sx, sy):
    cx, cy = screen_to_client(hwnd, sx, sy)
    lp = lparam(cx, cy)
    user32.PostMessageW(hwnd, WM_MOUSEMOVE, 0, lp)
    user32.PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp)
    time.sleep(0.03)
    user32.PostMessageW(hwnd, WM_LBUTTONUP, 0, lp)
    time.sleep(0.12)


def post_text(hwnd, text):
    for ch in text:
        user32.PostMessageW(hwnd, WM_CHAR, ord(ch), 0)
        time.sleep(0.01)


def post_enter(hwnd):
    user32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 0)
    time.sleep(0.02)
    user32.PostMessageW(hwnd, WM_KEYUP, VK_RETURN, 0)


VK_BACK = 0x08
VK_CONTROL = 0x11

def _lparam_key(scan, up=False):
    base = 0x00000001 | (scan << 16)
    return base | 0xC0000000 if up else base

def post_backspace(hwnd, n=1):
    sc = 0x0E  # backspace scan code — Qt needs this in lParam or it ignores the key
    for _ in range(n):
        user32.PostMessageW(hwnd, WM_KEYDOWN, VK_BACK, _lparam_key(sc))
        user32.PostMessageW(hwnd, WM_KEYUP, VK_BACK, _lparam_key(sc, up=True))
        time.sleep(0.008)

def post_key(hwnd, vk, n=1):
    for _ in range(n):
        user32.PostMessageW(hwnd, WM_KEYDOWN, vk, 0)
        user32.PostMessageW(hwnd, WM_KEYUP, vk, 0)
        time.sleep(0.01)


def clear_search(hwnd, sb):
    """Focus the search box and erase whatever's in it (backspaces with proper lParam)."""
    post_click(hwnd, *sb)
    time.sleep(0.12)
    post_backspace(hwnd, 50)
    time.sleep(0.12)


def ocr_pil(img):
    import io, asyncio
    buf = io.BytesIO(); img.save(buf, "PNG")
    return asyncio.run(_ocr(buf.getvalue()))

async def _ocr(png):
    from winrt.windows.storage.streams import InMemoryRandomAccessStream, DataWriter
    from winrt.windows.graphics.imaging import (BitmapDecoder, BitmapPixelFormat,
                                                BitmapAlphaMode, SoftwareBitmap)
    from winrt.windows.media.ocr import OcrEngine
    s = InMemoryRandomAccessStream(); w = DataWriter(s.get_output_stream_at(0))
    w.write_bytes(png); await w.store_async(); await w.flush_async(); s.seek(0)
    dec = await BitmapDecoder.create_async(s)
    bmp = await dec.get_software_bitmap_async()
    if bmp.bitmap_pixel_format != BitmapPixelFormat.BGRA8:
        bmp = SoftwareBitmap.convert(bmp, BitmapPixelFormat.BGRA8, BitmapAlphaMode.PREMULTIPLIED)
    eng = OcrEngine.try_create_from_user_profile_languages()
    return (await eng.recognize_async(bmp)).text if eng else ""


def regions_full():
    win = auto.WindowControl(searchDepth=1, ClassName="AllInOneWindow")
    if not win.Exists(2, 0.3):
        raise SystemExit("LINE window not found")
    out = {}
    left = win.GroupControl(searchDepth=30, ClassName="MainChatPanel")
    right = win.GroupControl(searchDepth=30, ClassName="ChatMessagePanel")
    if left.Exists(1, 0.2):
        r = left.BoundingRectangle; w = r.right - r.left
        out["left_panel"] = (r.left, r.top, r.right, r.bottom)
        out["search_box"] = (r.left + w // 2, r.top + 31)
        out["first_result"] = (r.left + w // 2, r.top + 80)
    if right.Exists(1, 0.2):
        r = right.BoundingRectangle; w = r.right - r.left
        out["right_panel"] = (r.left, r.top, r.right, r.bottom)
        out["header_screen"] = (r.left, r.top, w, 64)          # screen rect for header OCR
        out["composer"] = (r.left + int(w * 0.4), r.bottom - 55)
    return out


def crop_screen_rect(img, origin, sx, sy, w, h):
    ox, oy = origin
    return img.crop((sx - ox, sy - oy, sx - ox + w, sy - oy + h))


def norm(s):
    return "".join(c for c in (s or "") if not c.isspace()).lower()


import re
_GROUP_MARK = re.compile(r"\(\s*\d+\s*\)")  # "(4)" member-count -> a group, not a 1:1


def ocr_lines_pil(img, scale=2):
    """OCR an image, returning [(text, cx, cy)] where cx,cy are line-center coords
    in the ORIGINAL image's pixel space (for click targeting)."""
    import io, asyncio
    big = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)
    buf = io.BytesIO(); big.save(buf, "PNG")
    return asyncio.run(_ocr_lines(buf.getvalue(), scale))

async def _ocr_lines(png, scale):
    from winrt.windows.storage.streams import InMemoryRandomAccessStream, DataWriter
    from winrt.windows.graphics.imaging import (BitmapDecoder, BitmapPixelFormat,
                                                BitmapAlphaMode, SoftwareBitmap)
    from winrt.windows.media.ocr import OcrEngine
    s = InMemoryRandomAccessStream(); w = DataWriter(s.get_output_stream_at(0))
    w.write_bytes(png); await w.store_async(); await w.flush_async(); s.seek(0)
    dec = await BitmapDecoder.create_async(s)
    bmp = await dec.get_software_bitmap_async()
    if bmp.bitmap_pixel_format != BitmapPixelFormat.BGRA8:
        bmp = SoftwareBitmap.convert(bmp, BitmapPixelFormat.BGRA8, BitmapAlphaMode.PREMULTIPLIED)
    eng = OcrEngine.try_create_from_user_profile_languages()
    res = await eng.recognize_async(bmp)
    out = []
    for line in res.lines:
        xs, ys, x2s, y2s = [], [], [], []
        for word in line.words:
            r = word.bounding_rect
            xs.append(r.x); ys.append(r.y); x2s.append(r.x + r.width); y2s.append(r.y + r.height)
        if xs:
            cx = (min(xs) + max(x2s)) / 2 / scale
            cy = (min(ys) + max(y2s)) / 2 / scale
            out.append((line.text, cx, cy))
    return out


def find_exact_result(img, origin, region, target):
    """Click point (screen) of the search-result row whose name EXACTLY equals
    target (so '甲' won't match the group '甲x乙'). region = screen
    (x0,y0,x1,y1) of the chat-list column. None if absent."""
    ox, oy = origin
    x0, y0, x1, y1 = region
    crop = img.crop((x0 - ox, y0 - oy, x1 - ox, y1 - oy))
    nt = norm(target)
    for text, cx, cy in ocr_lines_pil(crop):
        line = _GROUP_MARK.sub("", text.strip())
        line = re.sub(r"(上午|下午|AM|PM)?\s*\d{1,2}:\d{2}.*$", "", line).strip()
        if norm(line) == nt:
            return (x0 + int(cx), y0 + int(cy))
    return None


def regions():
    win = auto.WindowControl(searchDepth=1, ClassName="AllInOneWindow")
    if not win.Exists(2, 0.3):
        raise SystemExit("LINE window not found")
    out = {}
    left = win.GroupControl(searchDepth=30, ClassName="MainChatPanel")
    if left.Exists(1, 0.2):
        r = left.BoundingRectangle; w = r.right - r.left
        out["search_box"] = (r.left + w // 2, r.top + 31)
        out["first_result"] = (r.left + w // 2, r.top + 80)
    return out


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "cap"
    if cmd in ("restore", "maximize"):
        pid = linekey.find_pid()
        for w in enum_pid_windows(pid):
            if w["class"] == "Qt663QWindowIcon":
                user32.ShowWindow(w["hwnd"], 9)   # SW_RESTORE (un-minimize)
                time.sleep(0.2)
                user32.ShowWindow(w["hwnd"], 3)   # SW_MAXIMIZE
                user32.SetForegroundWindow(w["hwnd"])
                print(f"maximized hwnd={w['hwnd']}")
        return
    if cmd == "windows":
        pid = linekey.find_pid()
        for w in sorted(enum_pid_windows(pid), key=lambda x: -x["area"])[:12]:
            print(f"  hwnd={w['hwnd']} vis={w['visible']} area={w['area']:>10} "
                  f"class={w['class']!r} rect={w['rect']}")
        return
    hwnd = get_hwnd()
    if not hwnd:
        raise SystemExit("no visible LINE AllInOneWindow")
    outdir = os.path.join(linekey.REPO_ROOT, "_calib"); os.makedirs(outdir, exist_ok=True)

    if cmd == "cap":
        img, ok, origin = capture(hwnd)
        p = os.path.join(outdir, "post_cap.png"); img.save(p)
        print(f"hwnd={hwnd} PrintWindow_ok={ok} size={img.size} origin={origin}")
        print(f"saved {p}")
    elif cmd == "probe-type":
        text = sys.argv[2] if len(sys.argv) > 2 else "zzz_test"
        reg = regions()
        sb = reg.get("search_box")
        print(f"search_box={sb}; posting click + WM_CHAR {text!r} (no send)")
        post_click(hwnd, *sb)
        time.sleep(0.2)
        post_text(hwnd, text)
        time.sleep(0.5)
        img, ok, _ = capture(hwnd)
        p = os.path.join(outdir, "post_probe.png"); img.save(p)
        print(f"PrintWindow_ok={ok}; saved {p}  (check if {text!r} appeared in LINE's search)")

    elif cmd in ("select", "send"):
        name = sys.argv[2]
        text = sys.argv[3] if cmd == "send" and len(sys.argv) > 3 else None
        auto = "--auto" in sys.argv
        allow_group = "--allow-group" in sys.argv
        # 0) DB ground truth: resolve the EXACT chat + group status (fail closed)
        import linedb
        try:
            con = linedb.open_db(); cid = linedb.resolve_chat(con, name)
            db_name = linedb.chat_name(con, cid)
            is_group = cid[:1] != "u"
        except SystemExit as e:
            print(f"[abort] DB resolve failed (ambiguous/not found): {e}"); return
        print(f"[verify] DB: name={db_name!r} chatId={cid} isGroup={is_group}")
        if is_group and not allow_group:
            print("[abort] '{}' is a group/non-1:1 — refused (use --allow-group).".format(name)); return

        # UIA-derived coords — correct when LINE is in a STANDARD layout (maximized,
        # default chat-list column width). They only drift if the list column is resized.
        reg = regions_full()
        search_box = reg["search_box"]
        lp = reg["left_panel"]
        list_region = (lp[0], search_box[1] + 30, lp[2], lp[3] - 60)
        composer = reg["composer"]
        wl, wt, wr, wb = win_rect(hwnd); W = wr - wl; H = wb - wt

        # 1) search (clearing can collapse search + drop focus, so re-click before typing)
        clear_search(hwnd, search_box)
        post_click(hwnd, *search_box); time.sleep(0.2)
        post_text(hwnd, name); time.sleep(0.9)
        img, _, origin = capture(hwnd); img.save(os.path.join(outdir, "send_1_search.png"))
        # sanity: did the search actually filter? (the list should now be 甲-only)
        list_txt = ocr_pil(crop_screen_rect(img, origin, *list_region[:2],
                                            list_region[2] - list_region[0], 220))
        if norm(name) not in norm(list_txt):
            print(f"[abort] search did not filter to {name!r} (typing didn't register). "
                  f"list OCR={list_txt[:60]!r}. see send_1_search.png"); return

        # 2) click the result row whose name EXACTLY matches (not a longer group name)
        pt = find_exact_result(img, origin, list_region, db_name or name)
        if not pt:
            print(f"[abort] exact result row {db_name or name!r} not found "
                  f"(search may not have filtered / coords). see send_1_search.png"); return
        print(f"[verify] clicking exact result row at {pt}")
        post_click(hwnd, *pt); time.sleep(0.7)
        img, _, origin = capture(hwnd); img.save(os.path.join(outdir, "send_2_open.png"))

        # 3) secondary group-detector on the header band (primary guard = exact row + DB 1:1)
        header_text = ocr_pil(crop_screen_rect(img, origin, wl + int(0.14 * W), wt,
                                               int(0.42 * W), int(0.05 * H)))
        looks_group = bool(_GROUP_MARK.search(header_text))
        print(f"[verify] header band OCR = {header_text!r}  group={looks_group}")
        if looks_group and not allow_group:
            print("[abort] opened chat shows '(N)' => a group — refused."); return

        if cmd == "select":
            print(f"[ok] opened 1:1 {db_name or name!r} (exact result-row match + DB 1:1)."); return

        # 4) type the draft into the composer
        post_click(hwnd, *composer); time.sleep(0.25)
        post_text(hwnd, text); time.sleep(0.4)
        img, _, _ = capture(hwnd); img.save(os.path.join(outdir, "send_3_draft.png"))
        print(f"[ok] draft '{text}' typed into {db_name or name!r}. review send_3_draft.png")

        # 5) send only if explicitly asked
        if auto:
            post_enter(hwnd); time.sleep(0.5)
            img, _, _ = capture(hwnd); img.save(os.path.join(outdir, "send_4_sent.png"))
            print(f"[SENT] '{text}' -> {db_name or name}. capture: send_4_sent.png")
        else:
            print("[draft] auto=off — not sent. verify send_3_draft.png, then run: press-enter")
    elif cmd == "press-enter":
        reg = regions_full()
        post_click(hwnd, *reg["composer"]); time.sleep(0.25)  # focus composer first
        post_enter(hwnd); time.sleep(0.5)
        img, _, _ = capture(hwnd); p = os.path.join(outdir, "pressed.png"); img.save(p)
        print(f"focused composer + pressed Enter; saved {p}")

    elif cmd == "clear-test":
        reg = regions_full()
        clear_search(hwnd, reg["search_box"])
        time.sleep(0.3)
        img, _, _ = capture(hwnd); p = os.path.join(outdir, "clear_test.png"); img.save(p)
        print(f"cleared; saved {p} (search box should be empty)")

    elif cmd in ("verify-open", "send-open"):
        # Operate on whatever chat is CURRENTLY OPEN (you opened it manually).
        # Reliable for buried/inactive contacts that search ranks low.
        name = sys.argv[2]
        text = sys.argv[3] if cmd == "send-open" and len(sys.argv) > 3 else None
        auto = "--auto" in sys.argv
        allow_group = "--allow-group" in sys.argv
        reg = regions_full()
        img, _, origin = capture(hwnd); img.save(os.path.join(outdir, "open_1.png"))
        hx, hy, hw, hh = reg["header_screen"]
        header_text = ocr_pil(crop_screen_rect(img, origin, hx, hy, hw, hh))
        contains = norm(name) in norm(header_text)
        looks_group = bool(_GROUP_MARK.search(header_text))
        print(f"[verify] open header OCR = {header_text!r}  contains={contains} groupMarker={looks_group}")
        if not contains:
            print(f"[abort] the open chat header doesn't contain {name!r} — open the right chat first."); return
        if looks_group and not allow_group:
            print("[abort] open chat shows '(N)' member count => a group — refused (use --allow-group)."); return
        if cmd == "verify-open":
            print(f"[ok] open chat verified as 1:1 {name!r}."); return
        post_click(hwnd, *reg["composer"]); time.sleep(0.2)
        post_text(hwnd, text); time.sleep(0.4)
        img, _, _ = capture(hwnd); img.save(os.path.join(outdir, "open_2_draft.png"))
        print(f"[ok] draft typed into open chat {name!r}.")
        if auto:
            post_enter(hwnd); time.sleep(0.5)
            img, _, _ = capture(hwnd); img.save(os.path.join(outdir, "open_3_sent.png"))
            print(f"[SENT] '{text}' -> {name} (open chat). capture: open_3_sent.png")
        else:
            print("[draft] auto=off — left unsent. add --auto to send.")
    else:
        raise SystemExit(f"unknown cmd {cmd}")


if __name__ == "__main__":
    main()
