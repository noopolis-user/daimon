import { GROK_ENGINE_BROKER } from "../../contracts/runtimeContractManifest.js";
import type { RuntimeDirectoryEntry, RuntimeDirectoryIdentity } from "../runtimeHooks.js";

/** The broker worker may traverse its own runtime home, never list or mutate it. */
export function assertGrokRuntimeHomeDirectory(entry: RuntimeDirectoryEntry, label: string, runtime: RuntimeDirectoryIdentity): void {
  const permissions = Number(entry.mode) & 0o7777;
  const home = GROK_ENGINE_BROKER.worker.home.organizationRuntimeHome;
  if (permissions !== home.mode) throw new Error(`${label} must have mode 0710 for a brokered Grok agent`);
  if (entry.gid < (runtime.firstWorkerUid ?? GROK_ENGINE_BROKER.identities.firstWorkerUid) || entry.gid === runtime.gid) {
    throw new Error(`${label} must be group-owned by the agent's Grok worker group`);
  }
}
