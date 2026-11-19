// lessons.js without TextEncoder/TextDecoder (the mod runtime has neither): hand-made UTF-8 length and cut, same hashes as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "./lessons.js";

const SAMPLES = ["", "abc", "é", "日本語", "a😀b", "😀".repeat(5), "\ud800", "x\udc00y", "ab\ud83d", "\u0000\u007f\u0080߿ࠀ￿"];

test("utf8Length matches the real encoder, a lone surrogate counts 3", () => {
  for (const s of SAMPLES) assert.equal(L.utf8Length(s), new TextEncoder().encode(s).length, JSON.stringify(s));
  assert.equal(L.utf8Length(null), 0);
});

test("utf8Cut: longest prefix within the byte limit, never inside a character or a surrogate pair", () => {
  for (const s of SAMPLES) {
    for (let n = 0; n <= L.utf8Length(s) + 1; n++) {
      const c = L.utf8Cut(s, n);
      assert.ok(s.startsWith(c), `${JSON.stringify(s)} ${n}`);
      assert.ok(L.utf8Length(c) <= n, `${JSON.stringify(s)} ${n} fits`);
      const next = s.slice(c.length, c.length + ((s.codePointAt(c.length) ?? 0) > 0xffff ? 2 : 1));
      if (next) assert.ok(L.utf8Length(c + next) > n, `${JSON.stringify(s)} ${n} is maximal`);
    }
  }
  assert.equal(L.utf8Cut("a😀b", 4), "a");
  assert.equal(L.utf8Cut("a😀b", 5), "a😀");
});

test("entryHash and boundText give the same output with TextEncoder and TextDecoder deleted", () => {
  const entry = { n: 7, title: "Wörld 日本語 😀", body: ["line é", "two"] };
  const big = "### L-1 A\nb\n\n" + "### L-2 日本語\n" + "é".repeat(40000) + "\n\n### L-3 tail\nc\n";
  const wantHash = L.entryHash(entry);
  const wantBound = L.boundText(big);
  const wantBound2 = L.boundText("### L-1 A\nb\n\n### L-2 B\nhalf", { truncated: true });
  assert.equal(wantHash, "35cd89ec4ad3ba7e"); // pinned from the TextEncoder implementation (L1)
  const [te, td] = [globalThis.TextEncoder, globalThis.TextDecoder];
  delete globalThis.TextEncoder; delete globalThis.TextDecoder;
  try {
    assert.equal(L.entryHash(entry), wantHash);
    assert.equal(L.boundText(big), wantBound);
    assert.equal(L.boundText("### L-1 A\nb\n\n### L-2 B\nhalf", { truncated: true }), wantBound2);
    assert.equal(L.parseEntries(big).entries.length, wantBound ? L.parseEntries(wantBound).entries.length : 0);
  } finally { globalThis.TextEncoder = te; globalThis.TextDecoder = td; }
});
