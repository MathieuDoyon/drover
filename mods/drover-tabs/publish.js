// Publish a complete file under a name that must not exist yet. Pure Node, no Herdr import.
// The record is written in full to a uniquely named temp (created exclusively, fsynced), then linked to its final name with link(2),
// which fails when the name exists and never replaces it; the temp is unlinked right after. A final name therefore always holds a
// complete record, and two writers racing for one name cannot both win. The temp name is new for every write and the temp is never
// reopened: after the link it shares the published file's inode, so rewriting a leftover would change the published record.
// Any error other than EEXIST is thrown (fail closed). There is no rename fallback. The directory is not fsynced: an accepted limit.
import * as nodefs from "node:fs";
import { randomBytes } from "node:crypto";

export function publishExclusive(dir, name, text, { fs: over } = {}) {
  const fs = { ...nodefs, ...over };
  const temp = `${dir}/.tmp-${randomBytes(8).toString("hex")}`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    // writeSync may write fewer bytes than asked and still return normally: continue until every byte of the record is on the file.
    const buf = Buffer.from(text);
    for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let result = { ok: true };
  try {
    fs.linkSync(temp, `${dir}/${name}`);
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    result = { ok: false, code: "EEXIST" };
  }
  fs.unlinkSync(temp);
  return result;
}
