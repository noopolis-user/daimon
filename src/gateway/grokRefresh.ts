import { ENGINE_DESCRIPTORS } from "../engines/descriptors.js";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnRealTime as spawn } from "../runtime/taskClockProcess.js";
import { readChild } from "../pi/cliChildOutput.js";
import { terminateChild, trackCliChild } from "../pi/cliProcess.js";
import { classifyGrokAuthenticationDiagnostic, GrokSubscriptionAuthenticationRejectedError } from "../engines/grok/broker/grokAuthenticationError.js";
import { parseGrokAuth, type GrokLogin } from "./grokCredential.js";

const GROK = ENGINE_DESCRIPTORS.grok;

/** The CLI itself named the login refused (`grokAuthenticationError.ts`): the realm is gone, not the network. */
export class GrokRefreshRejected extends Error {
  constructor() { super("Grok refresh was rejected"); }
}

/**
 * Refreshes the login in `grokHome` the only proven way: the pinned CLI's
 * `models` command, with a positive environment. A diagnostic the CLI names as
 * an authentication refusal throws {@link GrokRefreshRejected}; every other
 * failure (timeout, network, 429) is an ordinary, transient error.
 */
export async function refreshGrokBrokerCredential(command: string, grokHome: string, timeoutMs = 15_000): Promise<void> {
  const child = trackCliChild(spawn(command, ["models"], { detached: process.platform !== "win32", env: { [GROK.homeEnvironment]: grokHome, HOME: grokHome, PATH: process.env.PATH, LANG: "C", LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"] }));
  try { await readChild(child, timeoutMs, [], { failureClassifier: classifyGrokAuthenticationDiagnostic }); }
  catch (error) { throw error instanceof GrokSubscriptionAuthenticationRejectedError ? new GrokRefreshRejected() : new Error("Grok broker credential refresh failed"); }
  finally { await terminateChild(child).catch(() => undefined); }
}

export type GrokRefresh = (current: GrokLogin) => Promise<GrokLogin>;
export type GrokRefreshOptions = Readonly<{ command: string; scratchRoot?: string; timeoutMs?: number; run?: typeof refreshGrokBrokerCredential }>;

/**
 * Gateway refresh: the CLI runs in a private scratch home seeded with the
 * current login, so the realm file changes only through the owner's atomic
 * write-back. The scratch home is removed before this returns.
 */
export function createGrokRefresh(options: GrokRefreshOptions): GrokRefresh {
  const run = options.run ?? refreshGrokBrokerCredential;
  return async (current) => {
    const home = await mkdtemp(path.join(options.scratchRoot ?? os.tmpdir(), "daimon-gateway-refresh-"));
    try {
      const file = path.join(home, GROK.auth.fileName);
      const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, GROK.auth.fileMode);
      try { await handle.writeFile(current.bytes); } finally { await handle.close(); }
      await run(options.command, home, options.timeoutMs);
      const reader = await open(file, constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0));
      let bytes: Buffer | undefined;
      try {
        const stat = await reader.stat();
        if (!stat.isFile() || stat.size > GROK.auth.maxCredentialBytes) throw new Error("Grok refresh left no usable login");
        bytes = await reader.readFile();
        return parseGrokAuth(bytes);
      } finally { bytes?.fill(0); await reader.close(); }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };
}
