import { assertBrokerTaskClockSlot } from "./grokBrokerTaskClock.js";
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
import { runGrokEngineBrokerTurn, type GrokEngineBrokerTurnResult } from "./grokEngineBrokerTurn.js";
import { createGrokWorkerIsolationGuard,grokBrokerAttestationInput,prepareGrokWorkerAttestation } from "./grokWorkerAttestation.js";
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
export async function startGrokEngineBroker(options: Readonly<{ grokCommand: string; nativeClient: string; credentialHome: string; turnStore: string; registrations: readonly GrokEngineBrokerRegistration[]; inferenceLedgerPath?: string }>) {
  const registrations = new Map(options.registrations.map((entry) => [entry.agentId, { ...entry, model: parseGrokBrokerModelPolicy(entry.model) }])); if (registrations.size !== options.registrations.length) throw new Error("engine broker registration conflict");
  const attestationFor = (registration: GrokEngineBrokerRegistration) => grokBrokerAttestationInput(registration, [...registrations.values()], grokBrokerWorkerConfigPins(registration.model));
  const inferenceLedgerPath=options.inferenceLedgerPath;const grants=inferenceLedgerPath===undefined?undefined:createLedgeredGrokInferenceGrants(inferenceLedgerPath);
  const lease=await acquireGrokBrokerRealmLease(options.credentialHome);const authority = new DurableGrokBrokerCredentialAuthority(options.grokCommand, options.credentialHome);try{await authority.initialize();}catch(error){await lease.close();throw error;} let proxy:Awaited<ReturnType<typeof startGrokBrokerProxy>>;try{proxy=await startGrokBrokerProxy(authority,undefined,undefined,undefined,grants);}catch(error){await lease.close();throw error;}let mcp:Awaited<ReturnType<typeof startEngineBrokerMcpFacade>>|undefined;try{mcp=await startEngineBrokerMcpFacade();for(const registration of registrations.values()){const snapshot=await prepareGrokWorkerAttestation(attestationFor(registration));assertBrokerTaskClockSlot(snapshot.configVariant,registrations.size);}}catch(error){if(mcp)await mcp.close().catch(()=>undefined);await proxy.close();await lease.close();throw error;}if(!mcp)throw new Error("engine broker unavailable");const turns = new EngineBrokerTurnRegistry(options.turnStore); const active: GrokBrokerActiveTurns = new Map(); let closed = false;
  const facade = mcp;
  const deps = {
    turns, proxy, mcp: facade, credentialStale: () => authority.isStale(),
    prepareIsolation: async (registration: GrokEngineBrokerRegistration) => { const attestation = attestationFor(registration); const snapshot = await prepareGrokWorkerAttestation(attestation); assertBrokerTaskClockSlot(snapshot.configVariant, registrations.size); return { guard: createGrokWorkerIsolationGuard(attestation, snapshot), configVariant: snapshot.configVariant }; },
    runNative: (input: Parameters<typeof runNativeBrokerTurn>[1], signal: AbortSignal) => runNativeBrokerTurn(options.nativeClient, input, signal)
  };
  return {
    turn: createGrokEngineBrokerTurnDispatch(registrations, active, () => closed, runGrokEngineBrokerTurn.bind(undefined, deps)),
    requestInferenceGrant(request: GrokInferenceGrantRequest) {
      if (closed || grants === undefined) throw new GrokInferenceGrantRefused("unavailable");
      if (authority.isStale()) throw new GrokInferenceGrantRefused("auth_stale");
      return grants.issue(request);
    },
    releaseInferenceGrant(grantId: string): boolean {
      if (grants === undefined) throw new GrokInferenceGrantRefused("unavailable");
      return grants.release(grantId);
    },
    async close(): Promise<void> { if (closed) return; closed = true; grants?.close(); const running=[...active.values()];for (const entry of running) entry.controller.abort();await Promise.allSettled(running.map((entry)=>entry.done));const results=await Promise.allSettled([facade.close(),proxy.close(),lease.close()]);const failures=results.flatMap((entry)=>entry.status==="rejected"?[entry.reason]:[]);if(failures.length)throw new AggregateError(failures,"engine broker shutdown failed"); },
    readiness: () => ({ providerProxyPort: proxy.port, mcpFacadePort:43_124, registrations: registrations.size,credentialStale:authority.isStale(),realmLease:true,workerIsolation:true })
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
