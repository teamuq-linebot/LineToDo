# Third-party software in the LINE 待辦看板 (tuqdev.line-todo) plugin package

| Component | Version | License | Where it is in the package |
|---|---|---|---|
| koffi (Niels Martignène) | 3.1.0 | MIT | JavaScript bundled into `backend/index.mjs`; native module `backend/native/win32-x64/koffi.node`; text in `LICENSES/koffi-LICENSE.txt` |
| better-sqlite3 (Joshua Wise) | 13.0.2 | MIT (SQLite itself: public domain) | JavaScript bundled into `backend/index.mjs`; native module `backend/native/win32-x64/better_sqlite3.node`; text in `LICENSES/better-sqlite3-LICENSE.txt` |
| SQLite3 Multiple Ciphers (Ulrich Telle) WASM build | 2.5.1 (SQLite 3.53.4) | MIT (SQLite: public domain; Emscripten glue: MIT / NCSA, see the header of `sqlite3.mjs`) | `vendor/sqlite3mc-wasm/sqlite3.mjs`, `vendor/sqlite3mc-wasm/sqlite3.wasm`; provenance in `vendor/sqlite3mc-wasm/PROVENANCE.json` |
| zod | 3.25.76 | MIT | bundled into `backend/index.mjs`, `ui/main.js`, `ui/settings.js`; text in `LICENSES/zod-LICENSE.txt` |
| React, React DOM, scheduler | 18.3.1 | MIT | bundled into `ui/main.js`, `ui/settings.js`; text in `LICENSES/react-LICENSE.txt` |

The package contains no PowerShell script, no second SQLite native addon (the encrypted LINE database is read by the WASM build above), and no signing key of any kind.
