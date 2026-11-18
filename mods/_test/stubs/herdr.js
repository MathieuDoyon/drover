// The test sets globalThis.__host before it loads the editor: { props, shared, appHome, exec, calls }.
const h = () => globalThis.__host;
export const props = () => h().props;
export const appHome = () => h().appHome;
import { execFile } from "node:child_process";
// `mv` runs for real (the inbox writer moves each reply into place with it) unless a test sets host.ownMv to model a failing one.
const realMv = (args) => new Promise((resolve) => execFile("mv", args, { encoding: "utf8" }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
export const exec = (cmd, args, ...rest) => (cmd === "mv" && !h().ownMv ? realMv(args) : h().exec(cmd, args, ...rest));
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
