import { ENGINE_DESCRIPTORS } from "../../descriptors.js";
import { spawnRealTime as spawn } from "../../../runtime/taskClockProcess.js";
import { readChild } from "../../../pi/cliChildOutput.js";
import { terminateChild, trackCliChild } from "../../../pi/cliProcess.js";

export async function refreshGrokBrokerCredential(command: string, grokHome: string, timeoutMs = 15_000): Promise<void> {
  const child = trackCliChild(spawn(command, ["models"], { detached: process.platform !== "win32", env: { [ENGINE_DESCRIPTORS.grok.homeEnvironment]: grokHome, HOME: grokHome, PATH: process.env.PATH, LANG: "C", LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"] }));
  try { await readChild(child, timeoutMs, []); }
  catch { throw new Error("Grok broker credential refresh failed"); }
  finally { await terminateChild(child).catch(() => undefined); }
}
