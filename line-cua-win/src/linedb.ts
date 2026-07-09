// linedb.ts — read LINE-for-Windows's encrypted local message DB via the Python
// helper (linedb.py + linekey.py + apsw-sqlite3mc). Fully-background, cursor-free,
// full-history data path: no UI, no OCR, no foreground. The helper decrypts a
// read-write COPY of LINE's wxSQLite3 AES-128 DB using the account key recovered
// from LINE.exe process memory (see linekey.py).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the project's venv python (has apsw-sqlite3mc). Falls back to python. */
function pythonPath(): string {
  const candidates = [
    join(__dirname, "..", ".venv", "Scripts", "python.exe"), // dist/ or src/ -> repo/.venv
    join(__dirname, "..", "..", ".venv", "Scripts", "python.exe"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return "python";
}

const SCRIPT = join(__dirname, "linedb.py");

export interface LineMessage {
  id: string;
  time: string | null;
  ts: number | null;
  direction: "in" | "out";
  sender: string;
  text: string;
}
export interface ChatCoverage {
  source: string;
  localMessageCount: number;
  returnedMessageCount?: number;
  limitApplied?: boolean;
  oldestLocalMessage: string | null;
  oldestLocalMessageTs?: number | null;
  newestLocalMessage: string | null;
  newestLocalMessageTs?: number | null;
  mayExcludeRemoteUnsyncedHistory: boolean;
}
export interface ChatHistory { chatId: string; name: string | null; messages: LineMessage[]; coverage?: ChatCoverage; }
export interface ChatSummary { chatId: string; name: string | null; lastUpdated: string | null; isGroup: boolean; }
export interface ChatCoverageResult extends ChatCoverage { chatId: string; name: string | null; }
export interface DbStatus {
  db: string | null; dbFound: boolean; linePid?: number | null; keyAvailable: boolean;
  decryptOk?: boolean; messageCount?: number; chatCount?: number; detail?: string;
}

/** Run linedb.py <args> and parse its JSON stdout. The helper emits a JSON error
 *  object and exits non-zero on failure; we surface that as a thrown Error. */
async function run<T>(args: string[]): Promise<T> {
  try {
    const { stdout } = await execFileAsync(pythonPath(), [SCRIPT, ...args], {
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(stdout) as T;
  } catch (err: any) {
    const out = (err?.stdout ?? "").toString().trim();
    if (out) {
      try {
        const j = JSON.parse(out);
        throw new Error(j.error ? `linedb: ${j.error}${j.matches ? " — " + JSON.stringify(j.matches) : ""}` : out);
      } catch (e: any) {
        if (e instanceof Error && e.message.startsWith("linedb:")) throw e;
        throw new Error(out);
      }
    }
    throw new Error(err?.message ?? String(err));
  }
}

export const dbStatus = () => run<DbStatus>(["status"]);
export const listChats = (limit = 50) => run<ChatSummary[]>(["list-chats", "--limit", String(limit)]);
/** Every chat in the local DB (no practical limit). Ground truth for the send
 *  guard's DB cross-check (identity + group status), independent of header OCR. */
export const allChats = () => run<ChatSummary[]>(["list-chats", "--limit", "1000000"]);
export const readChat = (name: string, limit = 0) =>
  run<ChatHistory>(["read", name, ...(limit ? ["--limit", String(limit)] : [])]);
export const chatCoverage = (name: string) => run<ChatCoverageResult>(["coverage", name]);
export const searchMessages = (text: string, limit = 50) =>
  run<any[]>(["search", text, "--limit", String(limit)]);

/** Format a chat history as a readable transcript, honest about local coverage. */
export function formatHistory(h: ChatHistory): string {
  const head = `${h.name ?? h.chatId} — ${h.messages.length} message(s)`;
  const lines = h.messages.map((m) => {
    const t = m.time ? m.time.replace("T", " ") : "?";
    const who = m.direction === "out" ? "me" : (m.sender || "them");
    const body = (m.text ?? "").replace(/\n/g, "\n      ");
    return `${t}  ${who}: ${body}`;
  });
  const out = [head, ...lines];
  const c = h.coverage;
  if (c) {
    const fmt = (s: string | null) => (s ? s.replace("T", " ") : "?");
    out.push(
      "",
      `— local DB: ${c.localMessageCount} message(s) stored` +
        (c.limitApplied ? `, ${c.returnedMessageCount} returned (limit applied)` : "") +
        `; oldest ${fmt(c.oldestLocalMessage)}, newest ${fmt(c.newestLocalMessage)}.`,
      `  This is the complete history PRESENT IN LINE Desktop's local DB. Messages` +
        ` that were never synced to this PC are not included.`,
    );
  }
  return out.join("\n");
}
