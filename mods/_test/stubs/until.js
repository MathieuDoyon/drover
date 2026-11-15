// Condition waits for async tests. Wait for the thing the next assert needs, never for a number of ticks.
// until() polls with a 1 ms timer (no busy loop); the cap is only a hang guard, not a timing budget.
// The cap runs on performance.now(): a test may freeze Date.now (config-wire does), which must not disable the guard.
export async function until(cond, label, cap = 10000) {
  const started = performance.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (performance.now() - started > cap) throw new Error(`until timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

// For "nothing happened" asserts: a bounded drain, so a wrongly-fired async effect gets a chance to show. It can never prove an absence, so it never guards a positive assert.
export const drain = async (ticks = 20) => { for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r)); };
