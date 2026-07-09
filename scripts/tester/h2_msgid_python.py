#!/usr/bin/env python3
"""H2 複驗（Python 端）：watch_json.row_to_obj 對「同 chat/同 ts/同 text、_id 不同」
兩列是否回不同 msgId，且每個輸出 dict 都含 msgId key。

不需真 LINE DB：注入 stub linedb.chat_name / my_mid，直接呼叫 row_to_obj。
另外印出兩列的完整 NDJSON（與 watch_json 真實 stdout 同格式），證明每行含 msgId。
"""
import os, sys, json

# 在 src/ 內執行，讓 watch_json 能 import linedb/linekey（與 App spawn cwd 一致）。
SRC = os.path.join(os.path.dirname(__file__), "..", "..", "line-cua-win", "src")
SRC = os.path.abspath(SRC)
sys.path.insert(0, SRC)
os.chdir(SRC)

import linedb
import watch_json

# stub：不碰真 DB。row_to_obj 只用到 chat_name（回退到 chatId / frm）。
linedb.chat_name = lambda con, x: None  # 強制走 "or c" / "or frm" 回退，聚焦 msgId
con = object()  # row_to_obj 不會對 con 做任何呼叫（chat_name 已 stub）
me = "uME"

# 構造「同聊天室、同毫秒 ts、同文字、同 direction、同 sender」兩則，僅 _id 不同。
# 模擬同一秒貼兩張圖（text 都會被 CT 換成 "[image]"），舊 hash 法會撞鍵。
CHAT = "cgroup1"
TS = 1719381720000          # 完全相同毫秒
FROM = "uABBY"
TEXT_IMG = None             # _text 為空 → body 走 CT label "[image]"
CT = 1                      # 1 = [image]
ID_A = "MSG_AAA_0001"
ID_B = "MSG_BBB_0002"

obj_a = watch_json.row_to_obj(con, me, CHAT, TS, FROM, TEXT_IMG, CT, ID_A)
obj_b = watch_json.row_to_obj(con, me, CHAT, TS, FROM, TEXT_IMG, CT, ID_B)

# 第三列：罕見無 _id（mid=None）→ msgId 應為 None（App 端走 d: fallback）。
obj_c = watch_json.row_to_obj(con, me, CHAT, TS, FROM, TEXT_IMG, CT, None)

print("[h2py] NDJSON_LINE_A=" + json.dumps(obj_a, ensure_ascii=False))
print("[h2py] NDJSON_LINE_B=" + json.dumps(obj_b, ensure_ascii=False))
print("[h2py] NDJSON_LINE_C(no _id)=" + json.dumps(obj_c, ensure_ascii=False))

# 斷言
has_msgid_key = all("msgId" in o for o in (obj_a, obj_b, obj_c))
a_id = obj_a["msgId"]
b_id = obj_b["msgId"]
distinct = a_id is not None and b_id is not None and a_id != b_id
# 同 chat/ts/text/dir/sender → 證明「除了 _id 外其餘欄位全同」（這正是舊 hash 撞鍵的條件）
same_other_fields = (
    obj_a["chatId"] == obj_b["chatId"]
    and obj_a["ts"] == obj_b["ts"]
    and obj_a["text"] == obj_b["text"]
    and obj_a["direction"] == obj_b["direction"]
    and obj_a["sender"] == obj_b["sender"]
)
c_is_none = obj_c["msgId"] is None
text_is_ct_label = obj_a["text"] == "[image]"  # 證明 text 確實被 CT 取代（撞鍵前提）

checks = {
    "has_msgId_key_all_lines": has_msgid_key,
    "A_B_msgId_distinct": distinct,
    "other_fields_identical(撞鍵前提)": same_other_fields,
    "text_collapsed_to_CT_label": text_is_ct_label,
    "no_id_row_msgId_is_None": c_is_none,
}
print("[h2py] msgId_A=" + repr(a_id) + " msgId_B=" + repr(b_id))
print("[h2py] checks=" + json.dumps(checks, ensure_ascii=False))
ok = all(checks.values())
print("[h2py] ALL-PASS=" + str(ok))

# 為 JS 端 deriveMsgId 複驗，輸出三列到檔（JS 讀回）。
out = {"a": obj_a, "b": obj_b, "c": obj_c}
outpath = os.path.join(os.path.dirname(os.path.abspath(__file__)), "h2_rows.json")
with open(outpath, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
print("[h2py] wrote " + outpath)

sys.exit(0 if ok else 1)
