# Standalone core and host

`src/shared/api.ts` is the renderer/core API contract. It contains no Electron imports. The preload exposes the same contract through `window.api`; renderer business components receive it through `LineTodoApiProvider` (`src/renderer/platform/LineTodoApi.tsx`). Only renderer bootstrap reads `window.api`.

`src/core/application.ts` composes one application instance from explicit ports. It owns a database connection and repository set for its `dataDir`, plus the API and service subscriptions. `src/core/runtime.ts` owns process lifecycle and the cross-process owner lock. It does not import Electron and can be assembled in Node with adapters supplied by the host.

The Electron standalone host is `src/main/index.ts`. It creates per-host settings, provider, pipeline configuration, media decryptor and scheduler adapters, constructs the runtime, and registers the IPC forwarding adapter in `src/main/ipc/application.ipc.ts`. IPC keeps the existing channel names and event shapes; feature logic runs through the runtime API. Main-owned LINE watcher, native media protocol, Windows path integration, and login-item behavior remain adapters at this boundary.

Database access for new runtime instances is created by `openDatabase({ dbPath })` and `createRepositories(db)`. Settings and Qwen/pipeline/provider factories take instance inputs. Pipeline scheduler dependencies are explicit, including the DB and provider/extractor callbacks. Media protocol/backup receive the runtime DB and decryptor instance. Legacy module-level helpers remain for existing probes/adapters; the standalone production composition uses the explicit factories.

Lifecycle contract: acquire the owner lock before initializing the data directory; start is idempotent; stop drains scheduled work and subscriptions; restart reopens an owned instance; dispose drains in-flight API calls, closes adapters and DB, and releases the owner lock. The host awaits dispose before completing `before-quit`.

The isolated acceptance host is enabled only with `LINE_TODO_ACCEPTANCE_MODE=1` and an explicit `LINE_TODO_ACCEPTANCE_DATA_DIR`. In that mode, LINE and extraction are fakes, external reconciliation/backfill/media jobs are skipped, the renderer bridge is exercised, and the app quits normally after the checks. Do not use this mode with a real user data directory.
