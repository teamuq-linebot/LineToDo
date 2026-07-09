// Copy the Python helpers next to the compiled JS so linedb.ts can spawn them.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
for (const f of ["linedb.py", "linekey.py"]) {
  copyFileSync(join(root, "src", f), join(dist, f));
  console.log("copied", f, "-> dist/");
}
