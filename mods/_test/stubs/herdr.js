// The test sets globalThis.__host before it loads the editor: { props, shared, appHome, exec, calls }.
const h = () => globalThis.__host;
export const props = () => h().props;
export const appHome = () => h().appHome;
import { execFile } from "node:child_process";
// `mv` runs for real (the inbox writer moves each reply into place with it) unless a test sets host.ownMv to model a failing one.
const realMv = (args) => new Promise((resolve) => execFile("mv", args, { encoding: "utf8" }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
// The load hold's local health read (T-MWO2HEU32E4) is a python3 call: unless a test sets host.pyExec (it then answers through host.exec), it gets a healthy machine, so every other test is unaffected.
const HEALTHY = JSON.stringify({ v: 1, os: "linux", cores: 4, load: { one: 0.1, five: 0.1, fifteen: 0.1 }, loadPerCore: 0.03, mem: { totalMb: 100, usedMb: 10, pct: 10 }, disks: { home: { totalMb: 1, freeMb: 1, pct: 5 }, tmp: { totalMb: 1, freeMb: 1, pct: 5 } } });
export const exec = (cmd, args, ...rest) => (cmd === "mv" && !h().ownMv ? realMv(args) : cmd === "python3" && !h().pyExec ? Promise.resolve({ code: 0, stdout: HEALTHY, stderr: "" }) : h().exec(cmd, args, ...rest));
export const shared = (k) => h().state[k];
export const setShared = (k, v) => { h().state[k] = v; };
export const closeOverlay = (...a) => h().closeOverlay(...a);
export const notify = (n) => h().notified.push(n);
export const theme = () => h().theme ?? new Proxy({}, { get: () => "#000" });
const none = () => undefined;
export const openOverlay = (...a) => h().openOverlay?.(...a);
// readTextFile: the host's own reader (null when the file is absent). A test sets __host.readTextFile.
export const readTextFile = (...a) => h().readTextFile?.(...a);
// A test may set __host.hc / __host.watchFolder to record or hold the call (default: a no-op, as before).
export const hc = (...a) => h().hc?.(...a);
export const watchFolder = (...a) => h().watchFolder?.(...a);
export const focused = () => h().focused;
export const home = () => h().home;
export const feedbackPasteImage = none, feedbackClearImages = none;
export const spaces = () => h().spaces ?? [];
export const panes = () => h().panes ?? [];
export const terminals = () => h().terminals ?? [];
export const agents = () => h().agents ?? [];
export const run = (...a) => h().run?.(...a);
export const writeTextFile = (...a) => h().writeTextFile?.(...a);
export const window = () => h().window;
export const layout = () => h().layout;
export const settings = () => h().settings ?? { zoom: 1 };
// Herdr's own bindings: a test sets __host.keys ([{ section, keys, action }]); none = an empty list.
export const keys = () => h().keys ?? [];
// The Dock badge: a test sets __host.setBadge to record each call (default: a no-op).
export const setBadge = (...a) => h().setBadge?.(...a);
