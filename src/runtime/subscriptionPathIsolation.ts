import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathsOverlap } from "./organizationRuntimeRecording.js";

type Mount = Readonly<{ device: string; root: string; point: string }>;
type Location = Readonly<{ path: string; identity?: string; ancestors: readonly string[]; filesystem?: { device: string; path: string } }>;

/** Kernel mount roots also reveal aliases of files and descendants of bind mounts.
 * Contract: https://docs.kernel.org/filesystems/proc.html (mountinfo and fdinfo). */
export function parseSubscriptionMountInfo(text: string): ReadonlyMap<string, Mount> {
  const result = new Map<string, Mount>();
  for (const line of text.trim().split("\n")) {
    const fields = line.split(" ");
    if (!/^\d+$/u.test(fields[0] ?? "") || !/^\d+:\d+$/u.test(fields[2] ?? "") || !fields.includes("-")) throw new Error("subscription mount identity is unavailable");
    const decode = (value: string) => value.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    const root = decode(fields[3] ?? ""), point = decode(fields[4] ?? "");
    if (!path.isAbsolute(root) || !path.isAbsolute(point)) throw new Error("subscription mount identity is unavailable");
    result.set(fields[0]!, { device: fields[2]!, root, point });
  }
  return result;
}

export async function createSubscriptionPathIsolation(roots: readonly string[]) {
  const mounts = process.platform === "linux" ? parseSubscriptionMountInfo(await readFile("/proc/self/mountinfo", "utf8")) : undefined;
  const claimed = await Promise.all(roots.map(root => describe(root, mounts)));
  return {
    async claim(candidate: string): Promise<void> {
      const location = await describe(candidate, mounts);
      if (claimed.some(other => overlaps(location, other))) throw new Error("subscription realm paths overlap agent or protected runtime state");
      claimed.push(location);
    }
  };
}

function overlaps(left: Location, right: Location): boolean {
  return pathsOverlap(left.path, right.path)
    || (left.identity !== undefined && right.ancestors.includes(left.identity))
    || (right.identity !== undefined && left.ancestors.includes(right.identity))
    || (left.filesystem !== undefined && right.filesystem !== undefined
      && left.filesystem.device === right.filesystem.device && pathsOverlap(left.filesystem.path, right.filesystem.path));
}

async function describe(value: string, mounts: ReadonlyMap<string, Mount> | undefined): Promise<Location> {
  let anchor = value;
  let entry: Awaited<ReturnType<typeof lstat>>;
  for (;;) {
    try { entry = await lstat(anchor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(anchor) === anchor) throw error;
      anchor = path.dirname(anchor);
    }
  }
  if ((!entry.isDirectory() && !entry.isFile()) || entry.isSymbolicLink()) throw new Error("subscription path identity is unavailable");
  const identity = (stat: typeof entry) => `${stat.dev}:${stat.ino}`;
  const ancestors: string[] = [];
  for (let current = anchor;; current = path.dirname(current)) {
    ancestors.push(identity(await lstat(current)));
    if (path.dirname(current) === current) break;
  }
  const location = { path: value, ...(value === anchor ? { identity: identity(entry) } : {}), ancestors };
  if (mounts === undefined) return location;
  const handle = await open(anchor, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (identity(await handle.stat()) !== identity(entry)) throw new Error("subscription path identity changed");
    const id = /^mnt_id:\s*(\d+)$/mu.exec(await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8"))?.[1];
    const mount = id === undefined ? undefined : mounts.get(id);
    if (mount === undefined || !contains(mount.point, anchor)) throw new Error("subscription mount identity is unavailable");
    return { ...location, filesystem: { device: mount.device, path: path.join(mount.root, path.relative(mount.point, value)) } };
  } finally { await handle.close(); }
}
const contains = (root: string, value: string): boolean => root === value || value.startsWith(root === path.parse(root).root ? root : `${root}${path.sep}`);
