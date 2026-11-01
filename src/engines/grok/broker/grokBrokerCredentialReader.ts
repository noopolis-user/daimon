import { ENGINE_DESCRIPTORS } from "../../descriptors.js";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { parseGrokAuth } from "../../../gateway/grokCredential.js";

export async function readGrokBrokerCredential(file: string): Promise<Readonly<{ accessToken: string; digest: string; expiresAt?: number }>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined; let bytes: Buffer | undefined; let parsed: Buffer | undefined;
  try {
    const before = await lstat(file); assertFile(before); handle = await open(file, constants.O_RDONLY | noFollow()); const opened = await handle.stat(); assertFile(opened);
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error(); bytes = await handle.readFile(); if (bytes.length > ENGINE_DESCRIPTORS.grok.auth.maxCredentialBytes) throw new Error(); const after = await handle.stat(); if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error();
    const login = parseGrokAuth(bytes); parsed = login.bytes;
    return { accessToken: login.accessToken, digest: login.digest, ...(login.expiresAt === undefined ? {} : { expiresAt: login.expiresAt }) };
  } catch { throw new Error("Grok broker credential authority unavailable"); }
  finally { bytes?.fill(0); parsed?.fill(0); await handle?.close().catch(() => undefined); }
}
function assertFile(entry: Awaited<ReturnType<typeof lstat>>): void { if (!entry.isFile() || entry.isSymbolicLink() || Number(entry.uid) !== process.getuid?.() || Number(entry.nlink) !== 1 || (Number(entry.mode) & 0o777) !== ENGINE_DESCRIPTORS.grok.auth.fileMode || Number(entry.size) < 2 || Number(entry.size) > ENGINE_DESCRIPTORS.grok.auth.maxCredentialBytes) throw new Error(); }
function noFollow(): number { return constants.O_NOFOLLOW ?? 0; }
