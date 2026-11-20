// drover-headless: the board writer of a machine, run over `hc exec`. Verbs and payloads: docs/headless-board.md. The logic is in ../headless-board.js.
// Read verbs: version|rev|tasks|projects [--json]. Write verbs read ONE JSON object on stdin (the payload is never an argument):
// add edit note move archive import move-out, and `project add`. `migrate-in --from <old shared.json>` takes a path. Exit 0 ok, 1 refused, 2 usage.
import fs from "node:fs";
import { boardDir, submit, versionInfo, revInfo, tasksInfo, projectsInfo, migrateIn } from "../headless-board.js";

const USAGE = `usage: drover-headless version|rev|tasks|projects [--json]
       drover-headless add|edit|note|move|archive|import|move-out   (payload: one JSON object on stdin)
       drover-headless project add                                  (payload on stdin)
       drover-headless migrate-in --from <path to an old shared.json>
`;
const WRITE = { add: "add", edit: "edit", note: "note", move: "move", archive: "archive", import: "import", "move-out": "move-out" };
const READ = { version: () => versionInfo(), rev: (d) => revInfo(d), tasks: (d) => tasksInfo(d), projects: (d) => projectsInfo(d) };
const usage = () => { process.stderr.write(USAGE); process.exit(2); };
// The write callback fires when the reply is flushed: exiting earlier cuts a reply bigger than the pipe buffer.
// It never resolves: the caller stops here until the exit.
const out = (j) => new Promise(() => { process.stdout.write(`${JSON.stringify(j)}\n`, () => process.exit(j.ok === false ? 1 : 0)); });
const refuse = (code, error) => out({ ok: false, code, error });

const args = process.argv.slice(2);
const verb = args.shift();
const dir = boardDir();
const rest = args.filter((a) => a !== "--json");

try {
  if (verb in READ) {
    if (rest.length) usage();
    let j; try { j = READ[verb](dir); } catch (e) { j = { ok: false, code: e?.boardCode ?? "io", error: String(e?.message ?? e) }; }
    await out(j);
  } else if (verb === "migrate-in") {
    if (rest.length !== 2 || rest[0] !== "--from" || !rest[1]) usage();
    await out(await migrateIn(dir, rest[1]));
  } else if (verb === "project" || verb in WRITE) {
    let op = WRITE[verb];
    if (verb === "project") { if (rest.length !== 1 || rest[0] !== "add") usage(); op = "project-add"; }
    else if (rest.length) usage();
    let env;
    try { env = JSON.parse(fs.readFileSync(0, "utf8")); } catch { await refuse("bad-envelope", "stdin is not one JSON object"); }
    if (env === null || typeof env !== "object" || Array.isArray(env)) await refuse("bad-envelope", "stdin is not one JSON object");
    if (env.op !== undefined && env.op !== op) await refuse("bad-envelope", `the payload op ${JSON.stringify(env.op)} contradicts the verb`);
    await out(await submit({ ...env, op }, { dir }));
  } else usage();
} catch (e) {
  await refuse("io", String(e?.message ?? e).slice(0, 200));
}
