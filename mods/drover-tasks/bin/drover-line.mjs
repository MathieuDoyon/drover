// `drover line` pre-check: the same rules the consumer applies (../runline.js), run BEFORE the request is written, so a secret-shaped
// text never reaches the inbox directory. Usage: node drover-line.mjs "<text>" [<progress>] (the argument is absent when the flag was not given). Prints the normalised text, then the normalised progress (empty: none), one per line, on stdout and exits 0;
// on a refusal prints "error: <rule>" on stderr (the rule name, never the text) and exits 2.
import { validate } from "../runline.js";

const v = validate(process.argv[2], process.argv.length > 3 ? process.argv[3] : undefined); // a supplied progress (even "") is validated; only an absent one is none
if (!v.ok) { process.stderr.write(`error: ${v.error}\n`); process.exit(2); }
process.stdout.write(`${v.text}\n${v.progress ?? ""}\n`);
