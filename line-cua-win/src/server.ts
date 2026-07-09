#!/usr/bin/env node
// server.ts — MCP stdio server exposing LINE-for-Windows tools.
//
// Read tools (line_status / list_chats / read_history / search_messages) work
// fully in the background off the decrypted local DB. UI tools (select_chat /
// send_message / sync_older_messages) drive the LINE window via the Windows
// driver (driver_win) and are gated by a fail-closed send guard.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  dbStatus,
  listChats,
  readChat,
  searchMessages,
  formatHistory,
} from "./linedb.js";

const server = new Server(
  { name: "line-cua-win", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "line_status",
    description:
      "Report local DB/key/decryption status and whether LINE is running. LINE must be running at least once so the DB key can be recovered from its memory; after the key is cached, DB-backed reads (list_chats / read_history / search_messages) work even with LINE closed. Does not move the cursor or change focus.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_chats",
    description:
      "List recent chats (most-recently-active first) from LINE's local database — fully background, no UI. Use to discover exact chat names/ids for read_history. Returns name, chatId, last-activity time, and whether it's a group.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max chats to return. Default 50.", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_history",
    description:
      "Read a chat's message history from LINE's local encrypted database — FULLY in the background: no cursor, no window focus change, no OCR, no scrolling. Returns every locally-stored message with sender direction and timestamps, plus a coverage footer. Messages never synced to this PC are not included. Identify the chat by name (1:1, group, community) or raw chatId; pass limit to cap to the most recent N messages.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Chat name (friend / group / community) or raw chatId." },
        limit: {
          type: "integer",
          description: "Max number of most-recent messages to return. Default 0 = entire history.",
          minimum: 0,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "search_messages",
    description:
      "Full-text-ish search across ALL chats' message bodies in the local DB (background, no UI). Returns matching messages with chat name, time, and direction, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Substring to search for in message text." },
        limit: { type: "integer", description: "Max matches to return. Default 50.", minimum: 1 },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "select_chat",
    description:
      "Open a LINE chat by name via the Windows UI. [Phase 2 — Windows UI driver not yet wired.]",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Exact chat / friend / group name as shown in LINE." } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to a LINE chat with a fail-closed recipient guard. [Phase 2 — Windows UI driver not yet wired.]",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact chat name to send to." },
        text: { type: "string", description: "Message body." },
        auto: { type: "boolean", description: "If true, actually send. If false (default), leave the draft unsent." },
        allowGroup: { type: "boolean", description: "If true, permit sending to a group. Default false (1:1 only)." },
      },
      required: ["name", "text"],
      additionalProperties: false,
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as any }));

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

const NOT_WIRED =
  "select_chat / send_message / sync_older_messages require the Windows UI driver (driver_win), which is implemented in phase 2. Read tools (line_status / list_chats / read_history / search_messages) are fully functional now.";

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "line_status": {
        const db = await dbStatus().catch((e) => ({ error: e?.message ?? String(e) }));
        return ok(JSON.stringify({ database: db }, null, 2));
      }
      case "list_chats": {
        const chats = await listChats((args as any).limit ?? 50);
        return ok(JSON.stringify(chats, null, 2));
      }
      case "read_history": {
        const hist = await readChat(String((args as any).name), (args as any).limit ?? 0);
        return ok(formatHistory(hist));
      }
      case "search_messages": {
        const res = await searchMessages(String((args as any).text), (args as any).limit ?? 50);
        return ok(JSON.stringify(res, null, 2));
      }
      case "select_chat":
      case "send_message":
        return fail(NOT_WIRED);
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return fail(err?.message ?? String(err));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("line-cua-win server running on stdio");
