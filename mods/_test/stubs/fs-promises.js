// The mod's fs/promises: the calls the runtime documents (readFile, writeFile, readdir, exists, unlink, rmdir, mkdir) over the real node fs.
// A test can model the runtime's grants and error shape with globalThis.__host.fsGuard(op, path): throw there to deny the call.
import * as real from "node:fs/promises";
// FS_DELAY_MS=<n> makes every call finish n ms late, like a slow disk: a test that waits a fixed tick count instead of its condition fails.
const slow = () => { const ms = Number(process.env.FS_DELAY_MS) || 0; return ms ? new Promise((r) => setTimeout(r, ms)) : undefined; };
const wrap = (op) => async (path, ...rest) => {
  const d = slow(); if (d) await d;
  globalThis.__host?.fsGuard?.(op, String(path));
  return real[op](path, ...rest);
};
export const readFile = wrap("readFile"), writeFile = wrap("writeFile"), readdir = wrap("readdir"), unlink = wrap("unlink"), rmdir = wrap("rmdir"), mkdir = wrap("mkdir");
export const exists = async (path) => { const d = slow(); if (d) await d; globalThis.__host?.fsGuard?.("exists", String(path)); return real.access(path).then(() => true, () => false); };
