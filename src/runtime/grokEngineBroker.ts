import { assertBrokerTaskClockSlot, writeBrokerTaskClock } from "./grokBrokerTaskClock.js";
import { DurableGrokBrokerCredentialAuthority } from "./grokBrokerCredentialAuthority.js";
import { runNativeBrokerTurn } from "./engineBrokerNativeClient.js";
import type { EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import type { EngineBrokerTurnLimitOverrides } from "./engineBrokerTurnAccounting.js";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { startEngineBrokerMcpFacade } from "./engineBrokerMcpFacade.js";
import { acquireGrokBrokerRealmLease } from "./grokBrokerRealmLease.js";
import { grokBrokerWorkerConfigPins } from "./grokBrokerWorkerConfig.js";
import { parseGrokBrokerModelPolicy } from "./grokBrokerModelPolicy.js";
import { runGrokEngineBrokerTurn, type GrokEngineBrokerTurnDependencies, type GrokEngineBrokerTurnResult } from "./grokEngineBrokerTurn.js";
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
  createIsolationGuard: typeof createGrokWorkerIsolationGuard;
  writeTaskClock: typeof writeBrokerTaskClock;
  workerIdentityEmpty: typeof grokWorkerIdentityEmpty;
  runNative: typeof runNativeBrokerTurn;
}>;

const brokerDependencies: GrokEngineBrokerDependencies = {
  acquireLease: acquireGrokBrokerRealmLease,
  createAuthority: (command, home) => new DurableGrokBrokerCredentialAuthority(command, home),
  startProxy: startGrokBrokerProxy,
  startMcp: startEngineBrokerMcpFacade,
  prepareAttestation: prepareGrokWorkerAttestation,
  createIsolationGuard: createGrokWorkerIsolationGuard,
  writeTaskClock: writeBrokerTaskClock,
  workerIdentityEmpty: (uid) => grokWorkerIdentityEmpty(uid, undefined, true),
  runNative: runNativeBrokerTurn
};

export async function startGrokEngineBroker(
  options: Readonly<{
    grokCommand: string; nativeClient: string; credentialHome: string; turnStore: string;
    registrations: readonly GrokEngineBrokerRegistration[]; inferenceLedgerPath?: string;
  }>,
  dependencies: GrokEngineBrokerDependencies = brokerDependencies
) {
  const registrations = new Map(options.registrations.map((entry) => [
    entry.agentId, { ...entry, model: parseGrokBrokerModelPolicy(entry.model) }
  ]));
  if (registrations.size !== options.registrations.length) throw new Error("engine broker registration conflict");
  const attestationFor = (registration: GrokEngineBrokerRegistration) => grokBrokerAttestationInput(
    registration, [...registrations.values()], grokBrokerWorkerConfigPins(registration.model)
  );
  const grants = options.inferenceLedgerPath === undefined
    ? undefined : createLedgeredGrokInferenceGrants(options.inferenceLedgerPath);
  const lease = await dependencies.acquireLease(options.credentialHome);
  const authority = dependencies.createAuthority(options.grokCommand, options.credentialHome);
  let proxy: Awaited<ReturnType<GrokEngineBrokerDependencies["startProxy"]>> | undefined;
  let mcp: Awaited<ReturnType<GrokEngineBrokerDependencies["startMcp"]>> | undefined;
  let clockedSlot = false;
  try {
    // Reconcile before accepting traffic. A prior broker may have died after
    // publishing an offset; its finally never ran. The realm lease excludes peers.
    for (const registration of registrations.values()) {
      const snapshot = await dependencies.prepareAttestation(attestationFor(registration));
      assertBrokerTaskClockSlot(snapshot.configVariant, registrations.size);
      if (snapshot.configVariant === "clocked") {
        const reaped = await awaitGrokWorkerIdentityEmpty(
          registration.workerUid, GROK_WORKER_REAP_WAIT_MS, dependencies.workerIdentityEmpty
        );
        if (!reaped) throw new Error("Grok broker task clock worker did not terminate");
        await dependencies.writeTaskClock(undefined);
        clockedSlot = true;
      }
    }
    await authority.initialize();
    proxy = await dependencies.startProxy(authority, undefined, undefined, undefined, grants);
    mcp = await dependencies.startMcp();
  } catch (error) {
    await Promise.allSettled([mcp?.close(), proxy?.close(), lease.close()]);
    grants?.close();
    throw error;
  }
  const turns = new EngineBrokerTurnRegistry(options.turnStore);
  const active: GrokBrokerActiveTurns = new Map();
  let closed = false;
  let clockFailed = false;
  const facade = mcp;
  const provider = proxy;
  const deps: GrokEngineBrokerTurnDependencies = {
    turns, proxy: provider, mcp: facade, credentialStale: () => authority.isStale(),
    clockedSlot, writeTaskClock: dependencies.writeTaskClock,
    workerIdentityEmpty: dependencies.workerIdentityEmpty,
    taskClockFailed: () => { clockFailed = true; },
    prepareIsolation: async (registration) => {
      const attestation = attestationFor(registration);
      const snapshot = await dependencies.prepareAttestation(attestation);
      assertBrokerTaskClockSlot(snapshot.configVariant, registrations.size);
      return {
        guard: dependencies.createIsolationGuard(attestation, snapshot),
        configVariant: snapshot.configVariant
      };
    },
    runNative: (input, signal) => dependencies.runNative(options.nativeClient, input, signal)
  };
  return {
    turn: createGrokEngineBrokerTurnDispatch(
      registrations, active, () => closed || clockFailed, runGrokEngineBrokerTurn.bind(undefined, deps)
    ),
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
      await Promise.allSettled(running.map((entry) => entry.done));
      const results = await Promise.allSettled([facade.close(), provider.close(), lease.close()]);
      const failures = results.flatMap((entry) => entry.status === "rejected" ? [entry.reason] : []);
      if (failures.length) throw new AggregateError(failures, "engine broker shutdown failed");
    },
    readiness: () => ({
      providerProxyPort: provider.port, mcpFacadePort: 43_124, registrations: registrations.size,
      credentialStale: authority.isStale(), realmLease: true, workerIsolation: !clockFailed
    })
  };
}

/** @internal One agent identity carries one turn until cleanup settles, including clock publication. */
export type GrokBrokerActiveTurns = Map<string, { controller: AbortController; done: Promise<void> }>;
type TurnArguments = [wakeId: string, prompt: string, mcpEndpoint: string, signal?: AbortSignal, limits?: EngineBrokerTurnLimitOverrides, processClock?: string];

/** The production dispatch boundary, isolated from credential/network setup for lifecycle tests. */
export function createGrokEngineBrokerTurnDispatch(
  registrations: ReadonlyMap<string, GrokEngineBrokerRegistration>, active: GrokBrokerActiveTurns,
  isClosed: () => boolean,
  run: (registration: GrokEngineBrokerRegistration, ...args: TurnArguments) => Promise<GrokEngineBrokerTurnResult>
) {
  return async (agentId: string, ...args: TurnArguments): Promise<GrokEngineBrokerTurnResult> => {
    const registration = registrations.get(agentId);
    if (isClosed() || registration === undefined) throw new Error("engine broker unavailable");
    if (active.has(agentId)) throw new Error("engine broker agent already active");
    const signal = args[3], controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    args[3] = controller.signal;
    const done = Promise.resolve().then(() => run(registration, ...args));
    active.set(agentId, { controller, done: done.then(() => undefined, () => undefined) });
    try { return await done; } finally { signal?.removeEventListener("abort", onAbort); active.delete(agentId); }
  };
}
