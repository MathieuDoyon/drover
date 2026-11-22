// Dock badge (T-MWO6FADBCH4): the unfiltered Needs-you count on the macOS Dock icon through Herdr's setBadge(text).
// Pure and injected: no herdr import. count() reads the needs cache's memory (B1), enabled() the setting; sync() runs from a timer, never from render.
// It writes only when the wanted text differs from the last one it wrote; 0 (or a bad count) and a disabled badge both clear it (null).
// `last` starts undefined, so the first sync always writes once: the host badge does not outlive the app.
export const badgeText = (n) => (Number.isInteger(n) && n > 0 ? String(n) : null);

export function createDockBadge({ count, enabled, setBadge }) {
  let last;
  const write = (wanted) => {
    if (wanted === last) return;
    try { setBadge(wanted); last = wanted; } catch { /* keep `last`: the next tick retries */ }
  };
  return {
    sync() { write(enabled() ? badgeText(count()) : null); },
    // Window close: clear what we set. Nothing to clear when we never wrote, or already cleared.
    clear() { if (last !== null && last !== undefined) write(null); },
  };
}
