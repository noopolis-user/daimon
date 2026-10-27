import { constants } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

/** Called only while holding the account's exclusive lease. */
export async function cleanupSubscriptionCredentialTemporaries(directory: string): Promise<void> {
  const owner = process.getuid?.();
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== owner || (parent.mode & 0o777) !== 0o700) throw new Error("unsafe credential directory");
  let changed = false;
  for (const name of await readdir(directory)) {
    if (!/^\.auth\.json\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/u.test(name)) continue;
    const file = path.join(directory, name);
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== owner || (entry.mode & 0o777) !== 0o600) throw new Error("unsafe credential temporary");
    await unlink(file);
    changed = true;
  }
  if (changed) {
    const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
