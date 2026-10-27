import { realpath } from "node:fs/promises";
import path from "node:path";
import { ENGINE_DESCRIPTORS, type EngineKind } from "../engines/descriptors.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import { createSubscriptionPathIsolation } from "./subscriptionPathIsolation.js";
import { assertNoSymlinkComponents } from "./physicalReadiness.js";

export type SubscriptionRealmPathPair = Readonly<{ bootstrapPath: string; durablePath: string }>;
/** Trusted host provisioning only; never accepted in agent configuration. */
export type SubscriptionRealmPaths = Partial<{
  readonly [Engine in EngineKind as typeof ENGINE_DESCRIPTORS[Engine]["auth"]["staging"] extends "portable-realm" ? Engine : never]: SubscriptionRealmPathPair
}>;
export type SubscriptionRealmHostOptions = Readonly<{
  sharedProtectedPaths?: readonly string[];
  subscriptionRealmPaths?: SubscriptionRealmPaths;
}>;

export async function prepareSubscriptionRealmPaths(
  input: SubscriptionRealmPaths | undefined,
  agents: readonly OrganizationRuntimeAgentConfig[],
  protectedStores: readonly string[] = []
): Promise<Partial<Record<EngineKind, SubscriptionRealmPathPair>>> {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) throw new Error("unsupported subscription realm paths");
  const resolved: Partial<Record<EngineKind, SubscriptionRealmPathPair>> = {};
  if (Object.keys(input ?? {}).length === 0) return Object.freeze(resolved);
  const mutableRoots = agents.flatMap(agent => [agent.workspacePath, agent.runtimeHomePath,
    ...(agent.memory === undefined ? [] : [agent.memory.runtimeHomePath]),
    ...(agent.recording === undefined ? [] : [agent.recording.directory, ...agent.recording.snapshots.map(source => source.path)])]);
  const forbiddenRoots = await Promise.all([...mutableRoots, ...protectedStores].map(root => canonicalFuturePath(root)));
  const isolation = await createSubscriptionPathIsolation(forbiddenRoots);
  for (const [name, pair] of Object.entries(input ?? {})) {
    const descriptor = ENGINE_DESCRIPTORS[name as EngineKind];
    if (!Object.hasOwn(ENGINE_DESCRIPTORS, name) || descriptor.auth.staging !== "portable-realm"
      || !agents.some(agent => agent.engine.kind === name) || pair === null || typeof pair !== "object"
      || Object.keys(pair).sort().join(",") !== "bootstrapPath,durablePath") throw new Error("unsupported subscription realm paths");
    const result: string[] = [];
    for (const configured of [pair.bootstrapPath, pair.durablePath]) {
      if (typeof configured !== "string" || !path.isAbsolute(configured) || configured === path.parse(configured).root
        || path.normalize(configured) !== configured) throw new Error("subscription realm paths must be canonical absolute paths");
      await assertNoSymlinkComponents(configured);
      const canonical = await realpath(configured);
      await isolation.claim(canonical);
      result.push(canonical);
    }
    resolved[name as EngineKind] = Object.freeze({ bootstrapPath: result[0]!, durablePath: result[1]! });
  }
  return Object.freeze(resolved);
}

async function canonicalFuturePath(value: string): Promise<string> {
  let ancestor = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await realpath(ancestor), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(ancestor) === ancestor) throw error;
      missing.push(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}
