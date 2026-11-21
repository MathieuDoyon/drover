// The asks hook (T-MWO2HGDSXX1): `drover-asks-hook set|clear`. Signal only: it prints nothing, never answers a dialog and always ends with exit 0.
// The watchdog starts before anything else is loaded; the payload is read for at most 250 ms and 64 KB (stdin may never close).
setTimeout(() => process.exit(0), 2000);
process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));
const action = process.argv[2];
const readInput = () => new Promise((resolve) => {
  const chunks = []; let total = 0, done = false, timer;
  const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8").slice(0, 65536)); };
  try {
    const s = process.stdin;
    if (s.isTTY) return finish();
    timer = setTimeout(finish, 250);
    s.on("data", (c) => { chunks.push(c); total += c.length; if (total >= 65536) finish(); });
    s.on("end", finish); s.on("error", finish); s.on("close", finish);
  } catch { finish(); }
});
try {
  const { runAsk } = await import("./asks-lib.mjs");
  const input = action === "set" ? await readInput() : "";
  runAsk({ action, env: process.env, input });
} catch {}
process.exit(0);
