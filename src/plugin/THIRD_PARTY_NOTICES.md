# Third-party software in the LINE 待辦 Pro (tuqdev.line-todo.pro) plugin package

| Component | Version | License | Where it is in the package |
|---|---|---|---|
| koffi (Niels Martignène) | 3.1.0 | MIT | JavaScript bundled into `backend/index.mjs`; native module `backend/native/win32-x64/koffi.node`; text in `LICENSES/koffi-LICENSE.txt` |
| better-sqlite3 (Joshua Wise) | 13.0.2 | MIT (SQLite itself: public domain) | JavaScript bundled into `backend/index.mjs`; native module `backend/native/win32-x64/better_sqlite3.node`; text in `LICENSES/better-sqlite3-LICENSE.txt` |
| SQLite3 Multiple Ciphers (Ulrich Telle) WASM build | 2.5.1 (SQLite 3.53.4) | MIT (SQLite: public domain; Emscripten glue: MIT / NCSA, see the header of `sqlite3.mjs`) | `vendor/sqlite3mc-wasm/sqlite3.mjs`, `vendor/sqlite3mc-wasm/sqlite3.wasm`; provenance in `vendor/sqlite3mc-wasm/PROVENANCE.json` |
| zod | 3.25.76 | MIT | bundled into `backend/index.mjs`, `ui/main.js`, `ui/settings.js`; text in `LICENSES/zod-LICENSE.txt` |
| React, React DOM, scheduler | 18.3.1 | MIT | bundled into `ui/main.js`, `ui/settings.js`; text in `LICENSES/react-LICENSE.txt` |
| @evex-dev/linejs | 3.6.4 | MIT | LINEJS protocol, QR login, IMAGE/FILE download, and user-initiated text/image/file send code bundled into `backend/index.mjs`; text in `LICENSES/linejs-LICENSE.txt` |
| qrcode | 1.5.4 | MIT | QR image rendering bundled into `backend/index.mjs`; text in `LICENSES/qrcode-LICENSE` |
| @noble/ciphers, crypto-js, curve25519-js, node-int64 | versions locked in `package-lock.json` | MIT | LINEJS cryptography / protocol support bundled into `backend/index.mjs`; license texts in matching `LICENSES/*-LICENSE` files |
| node-bignumber (Tom Wu JSBN / RSA.js) | 1.2.2 | Tom Wu permissive license; RSA.js portion MIT | LINEJS protocol support bundled into `backend/index.mjs`; full notices in `LICENSES/node-bignumber-LICENSE` |
| tweetnacl | 1.0.3 | Unlicense | LINEJS cryptography bundled into `backend/index.mjs`; text in `LICENSES/tweetnacl-LICENSE` |
| Apache Thrift (`thrift`) | 0.20.0 | Apache-2.0 | LINEJS protocol serialization bundled into `backend/index.mjs`; text in `LICENSES/thrift-LICENSE` |
| pngjs (qrcode's own copy), q | 5.0.0; q locked in `package-lock.json` | MIT | qrcode PNG rendering dependencies bundled into `backend/index.mjs`; texts in `LICENSES/pngjs-5-LICENSE` and `LICENSES/q-LICENSE` |
| pngjs | 7.0.0 | MIT | bundled into `backend/index.mjs`; text in `LICENSES/pngjs-LICENSE.txt` |

The package contains no PowerShell script, no second SQLite native addon (the encrypted LINE database is read by the WASM build above), and no signing key of any kind.
