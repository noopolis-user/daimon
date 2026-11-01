import path from "node:path";
import { rm } from "node:fs/promises";
import { assertBrokerTaskClockIsolation, brokerTaskClockFileFor } from "./grokBrokerSlot.js";
import { needsBrokerTaskClockReconciliation, writeBrokerTaskClock } from "./grokBrokerTaskClock.js";
import { DurableGrokBrokerCredentialAuthority } from "./grokBrokerCredentialAuthority.js";
import { runNativeBrokerTurn } from "./engineBrokerNativeClient.js";
import type { EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import type { EngineBrokerTurnLimitOverrides } from "./engineBrokerTurnAccounting.js";
import { ENGINE_BROKER_TASK_CLOCK_RESET_FAILED } from "./engineBrokerProtocol.js";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { GrokBrokerRunBudget } from "./grokBrokerRunBudget.js";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { startEngineBrokerMcpFacade } from "./engineBrokerMcpFacade.js";
import { acquireGrokBrokerRealmLease } from "./grokBrokerRealmLease.js";
import { createGrokGatewayAuthority, createGrokGatewayUpstream } from "./grokBrokerGateway.js";
import type { AgentGateway } from "../../../gateway/agentGateway.js";
import { grokBrokerWorkerConfigPins } from "./grokBrokerWorkerConfig.js";
import { parseGrokBrokerModelPolicy } from "./grokBrokerModelPolicy.js";
import {
  EngineBrokerTurnFailure, runGrokEngineBrokerTurn,
  type GrokEngineBrokerTurnDependencies, type GrokEngineBrokerTurnResult
} from "./grokEngineBrokerTurn.js";
import { createGrokWorkerIsolationGuard,grokBrokerAttestationInput,prepareGrokWorkerAttestation } from "./grokWorkerAttestation.js";
import { awaitGrokWorkerIdentityEmpty, GROK_WORKER_REAP_WAIT_MS, grokWorkerIdentityEmpty } from "./grokEngineBrokerTurnEnd.js";
import { createLedgeredGrokInferenceGrants, GrokInferenceGrantRefused, type GrokInferenceGrantRequest } from "./grokInferenceGrants.js";

export { EngineBrokerTurnFailure, type GrokEngineBrokerTurnResult } from "./grokEngineBrokerTurn.js";
export { finishBrokerTurnWithUsage } from "./grokEngineBrokerMetering.js";
export type GrokEngineBrokerRegistration = EngineBrokerServiceRegistration;
export type GrokEngineBroker = Awaited<ReturnType<typeof startGrokEngineBroker>>;

/**
 * The Grok engine broker: one credential realm, one provider proxy, one MCP
 * facade, and the root-provisioned registrations. Each registration declares
 * its own model/effort (whose worker config bytes are attested), usage ledger,
 * and turn limits (`engineBrokerServiceConfig.ts`).
 *
 * With an `inferenceLedgerPath` the broker also issues evaluator inference
 * grants (`grokInferenceGrants.ts`) over the same credential authority and
 * proxy; their rows go only to that ledger. A stale realm refuses a grant as
 * `auth_stale`, exactly as it fails subject turns.
 *
 * With a `gateway` the broker holds no Grok token and no realm lease: its
 * upstream is the auth gateway's `/v1/grok` with its own gateway key
 * (`grokBrokerGateway.ts`). Metering, admission, budgets, slots, sandbox and
 * MCP are unchanged; `realmLease` then reports that the gateway owns the realm.
 */
/** Internal seams exercise the production startup and per-turn admission paths. */
export type GrokEngineBrokerDependencies = Readonly<{
  acquireLease: typeof acquireGrokBrokerRealmLease;
  createAuthority: (command: string, home: string) => Pick<DurableGrokBrokerCredentialAuthority,
    "initialize" | "accessToken" | "markRejected" | "isStale">;
  startProxy: (...args: Parameters<typeof startGrokBrokerProxy>) => Promise<
    GrokEngineBrokerTurnDependencies["proxy"] & { port: number; close(): Promise<void> }>;
  startMcp: () => Promise<GrokEngineBrokerTurnDependencies["mcp"] & { close(): Promise<void> }>;
  prepareAttestation: typeof prepareGrokWorkerAttestation;
  needsTaskClockReconciliation: typeof needsBrokerTaskClockReconciliation;
  createIsolationGuard: typeof createGrokWorkerIsolationGuard;
  writeTaskClock: typeof writeBrokerTaskClock;
  workerIdentityEmpty: typeof grokWorkerIdentityEmpty;
  runNative: typeof runNativeBrokerTurn;
  /** Gateway-mode transport; production uses the global fetch. */
  gatewayFetch?: typeof fetch;
}>;

const brokerDependencies: GrokEngineBrokerDependencies = {
  acquireLease: acquireGrokBrokerRealmLease,
  createAuthority: (command, home) => new DurableGrokBrokerCredentialAuthority(command, home),
  startProxy: startGrokBrokerProxy,
  startMcp: startEngineBrokerMcpFacade,
  prepareAttestation: prepareGrokWorkerAttestation,
  needsTaskClockReconciliation: needsBrokerTaskClockReconciliation,
  createIsolationGuard: createGrokWorkerIsolationGuard,
  writeTaskClock: writeBrokerTaskClock,
  workerIdentityEmpty: (uid) => grokWorkerIdentityEmpty(uid, undefined, true),
  runNative: runNativeBrokerTurn
};

export async function startGrokEngineBroker(
  options: Readonly<{
    grokCommand: string; nativeClient: string; credentialHome: string; turnStore: string;
    registrations: readonly GrokEngineBrokerRegistration[]; inferenceLedgerPath?: string; maxRunRequests?: number; runRequestStore?: string;
    gateway?: AgentGateway;
  }>,
  dependencies: GrokEngineBrokerDependencies = brokerDependencies
) {
  const registrations = new Map(options.registrations.map((entry) => [
    entry.slot, { ...entry, model: parseGrokBrokerModelPolicy(entry.model) }
  ]));
  if (registrations.size !== options.registrations.length || new Set(options.registrations.map((entry) => entry.workerUid)).size !== options.registrations.length) throw new Error("engine broker registration conflict");
  const attestationFor = (registration: GrokEngineBrokerRegistration) => grokBrokerAttestationInput(
    registration, [...registrations.values()], grokBrokerWorkerConfigPins(registration.model, registration.slot)
  );
  const grants = options.inferenceLedgerPath === undefined
    ? undefined : createLedgeredGrokInferenceGrants(options.inferenceLedgerPath);
  const gatewayAuthority = options.gateway === undefined ? undefined : createGrokGatewayAuthority(options.gateway);
  const lease = gatewayAuthority === undefined ? await dependencies.acquireLease(options.credentialHome) : { close: async () => undefined };
  const authority = gatewayAuthority ?? dependencies.createAuthority(options.grokCommand, options.credentialHome);
  const upstream = gatewayAuthority === undefined ? undefined : createGrokGatewayUpstream(options.gateway!, gatewayAuthority, dependencies.gatewayFetch);
  let proxy: Awaited<ReturnType<GrokEngineBrokerDependencies["startProxy"]>> | undefined;
  let mcp: Awaited<ReturnType<GrokEngineBrokerDependencies["startMcp"]>> | undefined;
  let runBudget: GrokBrokerRunBudget | undefined;
  const clockedSlots = new Set<number>();
  try {
    // Reconcile before accepting traffic. A prior broker may have died after
    // publishing an offset; its finally never ran. The realm lease excludes peers.
    for (const registration of registrations.values()) {
      const attestation = attestationFor(registration);
      if (!await dependencies.needsTaskClockReconciliation(registration.profilePath, attestation.configSha256, brokerTaskClockFileFor(registration.slot))) continue;
      const snapshot = await dependencies.prepareAttestation(attestation);
      assertBrokerTaskClockIsolation(snapshot.configVariant, registration.slot, [...registrations.keys()], snapshot.denyPaths);
      const reaped = await awaitGrokWorkerIdentityEmpty(
        registration.workerUid, GROK_WORKER_REAP_WAIT_MS, dependencies.workerIdentityEmpty
      );
      if (!reaped) throw new Error("Grok broker task clock worker did not terminate");
      await dependencies.writeTaskClock(undefined, brokerTaskClockFileFor(registration.slot));
      clockedSlots.add(registration.slot);
    }
    await authority.initialize();
    runBudget = options.maxRunRequests === undefined ? undefined :
      await GrokBrokerRunBudget.open(options.maxRunRequests, path.join(options.runRequestStore ?? options.turnStore, "run-requests.json"));
    proxy = await dependencies.startProxy(authority, upstream, undefined, undefined, grants, runBudget);
    mcp = await dependencies.startMcp();
  } catch (error) {
    grants?.close();
    await Promise.allSettled([mcp?.close(), proxy?.close(), runBudget?.close()]);
    await Promise.allSettled([lease.close()]);
    throw error;
  }
  const slotStore = (slot: number) => path.join(options.turnStore, `slot-${slot}`);
  const turnStores = new Map([...registrations.keys()].map((slot) => [slot, new EngineBrokerTurnRegistry(slotStore(slot))]));
  const active: GrokBrokerActiveTurns = new Map();
  let closed = false;
  const clockFailed = new Set<number>();
  const resetting = new Set<number>();
  const resets = new Map<number, Promise<void>>();
  const facade = mcp;
  const provider = proxy;
  const depsFor = (registration: GrokEngineBrokerRegistration): GrokEngineBrokerTurnDependencies => ({
    turns: turnStores.get(registration.slot)!, proxy: provider, mcp: facade, credentialStale: () => authority.isStale(),
    clockedSlot: clockedSlots.has(registration.slot),
    writeTaskClock: (value) => dependencies.writeTaskClock(value, brokerTaskClockFileFor(registration.slot)),
    workerIdentityEmpty: dependencies.workerIdentityEmpty,
    taskClockFailed: () => { clockFailed.add(registration.slot); },
    prepareIsolation: async (registration) => {
      const attestation = attestationFor(registration);
      const snapshot = await dependencies.prepareAttestation(attestation);
      assertBrokerTaskClockIsolation(snapshot.configVariant, registration.slot, [...registrations.keys()], snapshot.denyPaths);
      if (snapshot.configVariant === "clocked") clockedSlots.add(registration.slot);
      return {
        guard: dependencies.createIsolationGuard(attestation, snapshot),
        configVariant: snapshot.configVariant
      };
    },
    runNative: (input, signal) => dependencies.runNative(options.nativeClient, input, signal)
  });
  return {
    turn: createGrokEngineBrokerTurnDispatch(
      registrations, active, () => closed, async (registration, ...args) => {
        if (clockFailed.has(registration.slot)) throw new EngineBrokerTurnFailure(
          "unavailable", undefined,
          { outcome: "failed", usage: null, model: registration.model.model, requests: 0, limitReason: "none" },
          undefined, undefined, undefined, ENGINE_BROKER_TASK_CLOCK_RESET_FAILED
        );
        return runGrokEngineBrokerTurn(depsFor(registration), registration, ...args);
      }, resetting
    ),
    async resetSlot(slot: number): Promise<void> {
      const registration = registrations.get(slot);
      if (closed || registration === undefined) throw new Error("engine broker unavailable");
      if (active.has(slot) || resetting.has(slot)) throw new Error("engine broker slot busy");
      resetting.add(slot);
      const reset = (async () => {
        try {
          const empty = await awaitGrokWorkerIdentityEmpty(registration.workerUid, GROK_WORKER_REAP_WAIT_MS, dependencies.workerIdentityEmpty);
          if (!empty) throw new Error("engine broker slot busy");
          if (clockedSlots.has(slot)) await dependencies.writeTaskClock(undefined, brokerTaskClockFileFor(slot));
          await rm(slotStore(slot), { recursive: true, force: true });
          turnStores.set(slot, new EngineBrokerTurnRegistry(slotStore(slot)));
          clockFailed.delete(slot);
        } catch (error) { clockFailed.add(slot); throw error; }
      })();
      resets.set(slot, reset);
      try { await reset; } finally { resetting.delete(slot); resets.delete(slot); }
    },
    requestInferenceGrant(request: GrokInferenceGrantRequest) {
      if (closed || grants === undefined) throw new GrokInferenceGrantRefused("unavailable");
      if (authority.isStale()) throw new GrokInferenceGrantRefused("auth_stale");
      return grants.issue(request);
    },
    releaseInferenceGrant(grantId: string): boolean {
      if (grants === undefined) throw new GrokInferenceGrantRefused("unavailable");
      return grants.release(grantId);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      grants?.close();
      const running = [...active.values()];
      for (const entry of running) entry.controller.abort();
      await Promise.allSettled([...running.map((entry) => entry.done), ...resets.values()]);
      const results = await Promise.allSettled([facade.close(), provider.close(), runBudget?.close()]);
      results.push(...await Promise.allSettled([lease.close()]));
      const failures = results.flatMap((entry) => entry.status === "rejected" ? [entry.reason] : []);
      if (failures.length) throw new AggregateError(failures, "engine broker shutdown failed");
    },
    readiness: () => ({
      providerProxyPort: provider.port, mcpFacadePort: 43_124, registrations: registrations.size,
      credentialStale: authority.isStale(), realmLease: true, workerIsolation: clockFailed.size === 0
    })
  };
}

/** @internal One slot identity carries one turn until cleanup settles, including clock publication. */
export type GrokBrokerActiveTurns = Map<number, { controller: AbortController; done: Promise<void> }>;
type TurnArguments = [wakeId: string, prompt: string, mcpEndpoint: string, signal?: AbortSignal, limits?: EngineBrokerTurnLimitOverrides, processClock?: string];

/** The production dispatch boundary, isolated from credential/network setup for lifecycle tests. */
export function createGrokEngineBrokerTurnDispatch(
  registrations: ReadonlyMap<number, GrokEngineBrokerRegistration>, active: GrokBrokerActiveTurns,
  isClosed: () => boolean,
  run: (registration: GrokEngineBrokerRegistration, ...args: TurnArguments) => Promise<GrokEngineBrokerTurnResult>,
  resetting: ReadonlySet<number> = new Set()
) {
  return async (agentId: string, ...input: [...TurnArguments, slot?: number]): Promise<GrokEngineBrokerTurnResult> => {
    const [wakeId, prompt, mcpEndpoint, signal_, limits, processClock, requestedSlot] = input;
    const matches = [...registrations.values()].filter((entry) => entry.agentId === agentId);
    const registration = requestedSlot === undefined ? (matches.length === 1 ? matches[0] : undefined) : registrations.get(requestedSlot);
    const args: TurnArguments = [wakeId, prompt, mcpEndpoint, signal_, limits, processClock];
    if (isClosed() || registration === undefined || registration.agentId !== agentId) throw new Error("engine broker unavailable");
    const slot = registration.slot;
    if (active.has(slot) || resetting.has(slot)) throw new Error("engine broker slot already active");
    const signal = args[3], controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    args[3] = controller.signal;
    const done = Promise.resolve().then(() => run(registration, ...args));
    active.set(slot, { controller, done: done.then(() => undefined, () => undefined) });
    try { return await done; } finally { signal?.removeEventListener("abort", onAbort); active.delete(slot); }
  };
}
