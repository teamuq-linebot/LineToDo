#!/usr/bin/env python3
"""driver_win — Windows UI driver for LINE Desktop (Qt6).

LINE's Qt widgets expose a UIA tree with rectangles but NO text, so we drive by
geometry (clicks computed from panel rects) + keyboard (SendInput) and verify the
open recipient by OCR'ing the conversation header (the send guard's safety net).

Unlike macOS this MOVES the cursor and foregrounds LINE — by necessity (Qt paints
into a single HWND, so there are no per-widget windows to PostMessage).

CLI (safe, no sending):
    driver_win.py locate            # find window + panels, print rects
    driver_win.py calibrate         # foreground LINE + screenshot each target region
    driver_win.py header            # OCR the currently-open conversation header
"""
import sys, os, io, time, ctypes, asyncio
from ctypes import wintypes
import uiautomation as auto
import mss
from PIL import Image
import linekey

# ---------------- Win32 input primitives ----------------
user32 = ctypes.WinDLL("user32", use_last_error=True)
INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
KEYEVENTF_KEYUP, KEYEVENTF_UNICODE = 0x0002, 0x0004
MOUSEEVENTF_MOVE_ABS = 0x8000 | 0x0001
MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
VK_RETURN, VK_CONTROL, VK_A, VK_DELETE, VK_ESCAPE = 0x0D, 0x11, 0x41, 0x2E, 0x1B

ULONG_PTR = ctypes.c_size_t

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR)]
class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]
class _IUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]
class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _IUNION)]

def _send(*inputs):
    arr = (INPUT * len(inputs))(*inputs)
    user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))

def key(vk, up=False):
    return INPUT(type=INPUT_KEYBOARD,
                 u=_IUNION(ki=KEYBDINPUT(wVk=vk, wScan=0,
                           dwFlags=KEYEVENTF_KEYUP if up else 0, time=0, dwExtraInfo=0)))

def tap(vk):
    _send(key(vk)); _send(key(vk, up=True)); time.sleep(0.03)

def chord_ctrl(vk):
    _send(key(VK_CONTROL)); _send(key(vk)); _send(key(vk, up=True)); _send(key(VK_CONTROL, up=True))
    time.sleep(0.03)

def type_unicode(text):
    for ch in text:
        code = ord(ch)
        down = INPUT(type=INPUT_KEYBOARD, u=_IUNION(ki=KEYBDINPUT(
            wVk=0, wScan=code, dwFlags=KEYEVENTF_UNICODE, time=0, dwExtraInfo=0)))
        up = INPUT(type=INPUT_KEYBOARD, u=_IUNION(ki=KEYBDINPUT(
            wVk=0, wScan=code, dwFlags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time=0, dwExtraInfo=0)))
        _send(down); _send(up); time.sleep(0.008)

def _vscreen():
    SM_XVIRTUAL, SM_YVIRTUAL, SM_CXVIRTUAL, SM_CYVIRTUAL = 76, 77, 78, 79
    g = user32.GetSystemMetrics
    return g(SM_XVIRTUAL), g(SM_YVIRTUAL), g(SM_CXVIRTUAL), g(SM_CYVIRTUAL)

def click(x, y):
    vx, vy, vw, vh = _vscreen()
    ax = int((x - vx) * 65535 / (vw - 1))
    ay = int((y - vy) * 65535 / (vh - 1))
    mv = INPUT(type=INPUT_MOUSE, u=_IUNION(mi=MOUSEINPUT(dx=ax, dy=ay, mouseData=0,
              dwFlags=MOUSEEVENTF_MOVE_ABS, time=0, dwExtraInfo=0)))
    dn = INPUT(type=INPUT_MOUSE, u=_IUNION(mi=MOUSEINPUT(dx=ax, dy=ay, mouseData=0,
              dwFlags=MOUSEEVENTF_LEFTDOWN, time=0, dwExtraInfo=0)))
    up = INPUT(type=INPUT_MOUSE, u=_IUNION(mi=MOUSEINPUT(dx=ax, dy=ay, mouseData=0,
              dwFlags=MOUSEEVENTF_LEFTUP, time=0, dwExtraInfo=0)))
    _send(mv); time.sleep(0.05); _send(dn); _send(up); time.sleep(0.12)

# ---------------- window / region discovery ----------------
def locate_line():
    win = auto.WindowControl(searchDepth=1, ClassName="AllInOneWindow")
    if not win.Exists(2, 0.3):
        raise SystemExit("LINE window (AllInOneWindow) not found — is LINE open & not minimized?")
    return win

def _rect(c):
    r = c.BoundingRectangle
    return (r.left, r.top, r.right, r.bottom)

def regions(win):
    """Best-effort region rects, computed from the two main panels."""
    out = {"window": _rect(win)}
    left = win.GroupControl(searchDepth=30, ClassName="MainChatPanel")
    right = win.GroupControl(searchDepth=30, ClassName="ChatMessagePanel")
    if left.Exists(1, 0.2):
        l, t, r, b = _rect(left); w = r - l
        out["left_panel"] = (l, t, r, b)
        out["search_box"] = (l + w // 2, t + 31)               # click point
        out["first_result"] = (l + w // 2, t + 80)             # top list row
    if right.Exists(1, 0.2):
        l, t, r, b = _rect(right); w = r - l
        out["right_panel"] = (l, t, r, b)
        out["header_bbox"] = (l + 8, t + 4, min(520, w - 16), 56)   # for OCR (left,top,w,h)
        out["composer"] = (l + int(w * 0.4), b - 60)           # click point
    return out

# ---------------- OCR ----------------
def grab_png(left, top, w, h, scale=2):
    with mss.MSS() as sct:
        raw = sct.grab({"left": left, "top": top, "width": w, "height": h})
    img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
    if scale != 1:
        img = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)
    buf = io.BytesIO(); img.save(buf, "PNG"); return buf.getvalue(), img

async def _ocr(png):
    from winrt.windows.storage.streams import InMemoryRandomAccessStream, DataWriter
    from winrt.windows.graphics.imaging import (BitmapDecoder, BitmapPixelFormat,
                                                BitmapAlphaMode, SoftwareBitmap)
    from winrt.windows.media.ocr import OcrEngine
    stream = InMemoryRandomAccessStream()
    w = DataWriter(stream.get_output_stream_at(0)); w.write_bytes(png)
    await w.store_async(); await w.flush_async(); stream.seek(0)
    dec = await BitmapDecoder.create_async(stream)
    bmp = await dec.get_software_bitmap_async()
    if bmp.bitmap_pixel_format != BitmapPixelFormat.BGRA8:
        bmp = SoftwareBitmap.convert(bmp, BitmapPixelFormat.BGRA8, BitmapAlphaMode.PREMULTIPLIED)
    eng = OcrEngine.try_create_from_user_profile_languages()
    if eng is None:
        return ""
    res = await eng.recognize_async(bmp)
    return res.text or ""

def ocr_bbox(left, top, w, h):
    png, _ = grab_png(left, top, w, h)
    return asyncio.run(_ocr(png))

def norm(s):
    return "".join(ch for ch in (s or "") if not ch.isspace()).lower()

# ---------------- CLI ----------------
def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "locate"
    win = locate_line()
    reg = regions(win)
    if cmd == "locate":
        for k, v in reg.items():
            print(f"  {k}: {v}")
    elif cmd == "header":
        hb = reg.get("header_bbox")
        if not hb:
            raise SystemExit("no right panel / header region")
        print("header OCR:", repr(ocr_bbox(*hb)))
    elif cmd == "calibrate":
        # foreground LINE, screenshot each target region so coordinates can be verified
        win.SetActive(); win.SetTopmost(False); time.sleep(0.4)
        outdir = os.path.join(linekey.REPO_ROOT, "_calib"); os.makedirs(outdir, exist_ok=True)
        wl, wt, wr, wb = reg["window"]
        shots = {
            "00_window": (wl, wt, wr - wl, min(wb - wt, 1000)),
            "01_left_top": (reg["left_panel"][0], reg["left_panel"][1], 360, 130) if "left_panel" in reg else None,
            "02_right_top": (reg["right_panel"][0], reg["right_panel"][1], 700, 120) if "right_panel" in reg else None,
            "03_right_bottom": (reg["right_panel"][0], reg["right_panel"][3] - 130, 700, 130) if "right_panel" in reg else None,
        }
        for name, box in shots.items():
            if not box:
                continue
            _, img = grab_png(*box, scale=1)
            p = os.path.join(outdir, name + ".png"); img.save(p)
            print(f"  saved {p}  bbox={box}")
        print("[*] regions:")
        for k, v in reg.items():
            print(f"    {k}: {v}")
    else:
        raise SystemExit(f"unknown cmd {cmd}")

if __name__ == "__main__":
    main()
