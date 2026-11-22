// Child process for the SIGKILL sweep (asks-install-faults.test.js): runs the module and kills ITSELF just before/after the Nth eligible mutating call.
// env: ASKS_KILL_AT (n, 0 = never), ASKS_KILL_PHASE (before|after), ASKS_ARGV (JSON). Test-only; not a *.test.js file.
import { lib, eligible } from "./asks-install-helper.js";
const at = Number(process.env.ASKS_KILL_AT || 0), phase = process.env.ASKS_KILL_PHASE || "before";
let n = 0;
const hit = (when) => (label) => { if (!eligible(label)) return; if (when === "before") n++; if (at && n === at && phase === when) process.kill(process.pid, "SIGKILL"); };
const before = hit("before"), after = hit("after");
const code = await lib.main(JSON.parse(process.env.ASKS_ARGV), process.env, { out: () => {}, err: () => {}, isTTY: false }, { before, after, root: process.env.DROVER_TEST_ROOT });
console.log(JSON.stringify({ code, ops: n }));
