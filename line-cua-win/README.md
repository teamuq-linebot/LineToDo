# line-cua-win

A **Windows** MCP server for LINE Desktop — a ground-up rewrite of the macOS-only
[`line-cua-mcp`](https://github.com/andrew54068/line-cua-mcp).

It reads your LINE chat history **fully in the background** (no cursor, no window
focus, no OCR) by decrypting LINE's local encrypted database, and exposes it to
any MCP host (Claude Code, Claude Desktop, …).

> ⚠️ **Personal / experimental tool.** It decrypts *your own* LINE database on
> *your own* PC. Automating and decrypting a private messenger may conflict with
> LINE's Terms of Service — use at your own risk and responsibility.

---

## Why this is a rewrite, not a port

LINE for Windows stores history in the **same** wxSQLite3 / QtCipherSqlitePlugin
AES-128-CBC encrypted SQLite format as macOS (`qw*.edb`), so the *reader* logic
carries over. The hard difference is the **key**:

| | macOS (original) | Windows (this) |
|---|---|---|
| DB key location | macOS Keychain | **only in LINE.exe process memory** (issued by the server at login; not on disk) |
| How we get it | `security` CLI | scan LINE.exe memory for 32-hex candidates, confirm by **successful decryption** (offset-independent → survives LINE updates) |
| UI automation | AppleScript + CGEvent | Windows UI Automation *(phase 2)* |
| OCR | Apple Vision (Swift) | Windows.Media.Ocr *(phase 2)* |

The key recovery is validated by actually decrypting the DB, not by hard-coded
memory offsets, so it keeps working across LINE versions as long as LINE is
running when the key is first captured.

---

## Requirements

- Windows 10/11
- **Node.js ≥ 18**
- **Python ≥ 3.9** (3.13 tested)
- LINE for Windows (classic build; data under `%LOCALAPPDATA%\LINE\Data\db`)
- LINE **running and logged in at least once** so the key can be captured
  (after that it's cached in `.linekey` and reads work even with LINE closed)

## Setup

```bash
cd C:\Users\<you>\line-cua-win

# 1) Python env with the decryption engine
python -m venv .venv
.venv\Scripts\python.exe -m pip install apsw-sqlite3mc

# 2) Node deps + build
npm install
npm run build

# 3) Sanity check (decrypts your DB, runs the server end-to-end)
npm run smoke
```

`npm run smoke` should print your real chat names and message counts.

## Wire it into an MCP host

**Claude Desktop** — edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "line-cua-win": {
      "command": "node",
      "args": ["C:\\Users\\<you>\\line-cua-win\\dist\\server.js"]
    }
  }
}
```

**Claude Code (CLI):**

```bash
claude mcp add line-cua-win -- node C:\Users\<you>\line-cua-win\dist\server.js
```

Then ask, e.g. *"list my recent LINE chats"*, *"read my history with Alice"*,
*"search my LINE messages for 報價"*.

---

## Tools

| Tool | Status | What it does |
|---|---|---|
| `line_status` | ✅ | DB path, LINE pid, key/decrypt status, message/chat counts |
| `list_chats` | ✅ | Recent chats (name, id, last-active, is-group), background |
| `read_history` | ✅ | A chat's full local history with direction/timestamps + coverage footer |
| `search_messages` | ✅ | Substring search across all chats, newest first |
| `select_chat` | 🚧 phase 2 | Open a chat via the Windows UI |
| `send_message` | 🚧 phase 2 | Send with a fail-closed 1:1-only recipient guard |

The four read tools are **fully background** and need no UI. The two UI tools are
gated and currently return a clear "not wired yet" error.

## How key recovery works (`src/linekey.py`)

1. `$LINE_DB_KEY` if set → else cached `.linekey` (re-verified each run) → else
   live recovery.
2. Live recovery: `OpenProcess(PROCESS_VM_READ)` on LINE.exe, walk committed
   regions, collect every 32-hex string (ASCII **and** Qt UTF-16LE), try each as
   the passphrase (`cipher=aes128cbc, kdf_iter=1`) against a read-only DB
   snapshot; the one that reads `sqlite_master` is the key, then it's cached.

## Reading without disturbing LINE

Reads copy the DB **plus its `-wal`/`-shm`** to a temp dir and open the *copy*
(WAL merged → latest messages visible). LINE's live files are never locked or
modified.

## Security & privacy

- 100% local. **No network calls anywhere** in this project (verify in `src/`).
- `.linekey` holds your account's DB passphrase — it's `.gitignore`d. Treat it
  like a password; delete it to force re-capture (e.g. after re-login).
- Reading another process's memory is what AV/EDR may flag; this only reads, only
  LINE.exe, only for the key. Inspect `src/linekey.py` before trusting it.

## License

MIT
