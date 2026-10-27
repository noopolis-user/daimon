import { reportEngineTaskClockGap } from "../pi/engineTaskClock.js";
import { assertSubscriptionAuthority } from "./subscriptionAuthority.js";
import { getEngineHandler } from "../engines/registry.js";
import type { RuntimeHostResources } from "../engines/runtimeHooks.js";
import { readTaskClock } from "./taskClock.js";
import { memoryClockOptions } from "../pi/memoryClock.js";
import type { OrganizationRuntimeConfig } from "./organizationRuntime.js";
import { prepareOrganizationRuntimePaths, type OrganizationRuntimePathAuthority } from "./physicalReadiness.js";

export type OrganizationRuntimeHostReadiness = Readonly<RuntimeHostResources & {
  paths: OrganizationRuntimePathAuthority;
  close(): Promise<void>;
}>;

export async function prepareProductionReadiness(
  config: OrganizationRuntimeConfig
): Promise<OrganizationRuntimeHostReadiness> {
  const clock = readTaskClock();
  for (const agent of config.agents) reportEngineTaskClockGap(agent.engine.kind);
  if (config.agents.some((agent) => agent.memory !== undefined)) memoryClockOptions(clock);
  const paths = await prepareOrganizationRuntimePaths(config.agents);
  const resources: RuntimeHostResources = {};
  try {
    const handlers = [...new Set(config.agents.map((agent) => getEngineHandler(agent.engine.kind)))];
    handlers.sort((left, right) => left.hostReadinessOrder - right.hostReadinessOrder);
    for (const handler of handlers) {
      await handler.prepareHostReadiness(config.agents.filter((agent) => getEngineHandler(agent.engine.kind) === handler), paths, resources);
    }
    for (const agent of config.agents) assertSubscriptionAuthority(agent.engine.kind, resources);
    let closed = false;
    return {
      ...resources,
      paths,
      async close() {
        if (closed) return;
        closed = true;
        const results = await Promise.allSettled(
          [resources.agyRealm?.close(), ...Object.values(resources.credentialRealms ?? {}).map((realm) => realm?.close()), paths.close()].filter((value): value is Promise<void> => value !== undefined)
        );
        const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length > 0) {
          throw new AggregateError(failures, "organization runtime readiness cleanup failed");
        }
      }
    };
  } catch (error) {
    const cleanup = await Promise.allSettled(
      [resources.agyRealm?.close(), ...Object.values(resources.credentialRealms ?? {}).map((realm) => realm?.close()), paths.close()].filter((value): value is Promise<void> => value !== undefined)
    );
    const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        "organization runtime readiness failed and cleanup was incomplete"
      );
    }
    throw error;
  }
}
