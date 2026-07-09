// End-to-end smoke test: launch the built MCP server over stdio and exercise it
// through the real MCP client, exactly like Claude / any MCP host would.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = join(root, "dist", "server.js");

const transport = new StdioClientTransport({ command: process.execPath, args: [server] });
const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const text = (r) => (r.content?.[0]?.text ?? "").trim();

console.log("=== tools ===");
const { tools } = await client.listTools();
for (const t of tools) console.log(`  ${t.name}`);

console.log("\n=== line_status ===");
console.log(text(await client.callTool({ name: "line_status", arguments: {} })));

console.log("\n=== list_chats (limit 3) ===");
console.log(text(await client.callTool({ name: "list_chats", arguments: { limit: 3 } })));

console.log("\n=== read_history (first chat above, limit 2) ===");
const chats = JSON.parse(text(await client.callTool({ name: "list_chats", arguments: { limit: 1 } })));
const name = chats[0]?.name ?? chats[0]?.chatId;
console.log(text(await client.callTool({ name: "read_history", arguments: { name, limit: 2 } })));

console.log("\n=== send_message (expect fail-closed not-wired) ===");
const r = await client.callTool({ name: "send_message", arguments: { name, text: "x" } });
console.log("isError:", r.isError, "|", text(r));

await client.close();
console.log("\n[smoke] OK");
