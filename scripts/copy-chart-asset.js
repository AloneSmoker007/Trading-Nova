import {copyFile, mkdir, stat} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "lightweight-charts", "dist", "lightweight-charts.standalone.production.js");
const target = join(root, "web", "vendor", "lightweight-charts.standalone.production.js");

await mkdir(dirname(target), {recursive: true});
await copyFile(source, target);
const copied = await stat(target);
if (!copied.isFile() || copied.size < 100000 || copied.size > 500000) {
  throw new Error("Unexpected Lightweight Charts asset size; expected the pinned 4.2.3 production bundle.");
}
process.stdout.write("Prepared local Lightweight Charts 4.2.3 asset (" + copied.size + " bytes).\n");
