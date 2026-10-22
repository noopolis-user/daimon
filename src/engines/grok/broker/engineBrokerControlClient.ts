import { createHash, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { ENGINE_BROKER_VERSION, EngineBrokerProtocolMismatch, encodeEngineBrokerFrame,EngineBrokerFrameDecoder,parseEngineBrokerResponse, parseEngineBrokerSlot, type EngineBrokerRequest, type EngineBrokerResponse } from "./engineBrokerProtocol.js";
import type { EngineBrokerInferenceFailureCode, EngineBrokerInferenceRequest, EngineBrokerInferenceResponse } from "./engineBrokerInferenceProtocol.js";
import { ENGINE_BROKER_MCP_REFUSAL_REASONS, type EngineBrokerMcpCallObservation, type EngineBrokerMcpRefusalObservation, type EngineBrokerMcpTunnelObservation } from "./engineBrokerMcpCallLog.js";
import type { EngineBrokerTurnLimitOverrides } from "./engineBrokerTurnAccounting.js";
import type { GrokBrokerModel, GrokBrokerReasoningEffort } from "./grokBrokerModelPolicy.js";
import type { GrokInferencePurpose } from "../../../runtime/inferenceUsageLedger.js";
import type { GrokBrokerProviderClockObservation } from "./grokBrokerProviderClock.js";

/**
 * What the broker saw of the worker's MCP tool calls on a failed turn
 * (`engineBrokerMcpCallLog.ts`). Absent for a turn with no observation at all;
 * `outstanding` names every call that started and was never answered, with how
 * long it had been waiting — the one thing a completion-only tool receipt can
 * never say.
 */
const renderMcpCalls=(calls:EngineBrokerMcpCallObservation|undefined):string=>calls===undefined?"":`; mcp=${calls.answered}/${calls.started} answered${calls.undecoded===0?"":`; mcp_undecoded=${calls.undecoded}`}${calls.outstanding.length===0?"":`; mcp_outstanding=${calls.outstanding.map((call)=>`${call.name}@${call.outstandingMs}ms`).join(",")}`}${renderMcpRefusals(calls.refusals)}${renderMcpTunnels(calls.tunnels)}`;
/** The refusals the facade never relayed, by reason class, and only the classes that happened: a turn refused 403 must not read as a turn that was served. */
const renderMcpRefusals=(refusals:EngineBrokerMcpRefusalObservation|undefined):string=>{if(refusals===undefined)return"";const named=ENGINE_BROKER_MCP_REFUSAL_REASONS.filter((reason)=>refusals[reason]>0);return named.length===0?"":`; mcp_refused=${named.map((reason)=>`${reason}:${refusals[reason]}`).join(",")}`;};
/** The session's GET SSE tunnels: how many closed of how many opened, and each one still open with its age and whether the mount ever pushed through it. */
const renderMcpTunnels=(tunnels:EngineBrokerMcpTunnelObservation|undefined):string=>tunnels===undefined?"":`; mcp_get=${tunnels.closed}/${tunnels.opened} closed, ${tunnels.delivered} delivered${tunnels.open.length===0?"":`; mcp_get_open=${tunnels.open.map((tunnel)=>`${tunnel.openMs}ms/${tunnel.delivered?"delivered":"silent"}`).join(",")}`}`;

export type EngineBrokerInferenceGrant = Omit<Extract<EngineBrokerInferenceResponse, { kind: "inference_grant" }>, "version" | "kind" | "requestId">;
/** A refused grant request; `code` is closed (`auth_stale` is the stale shared realm, `grant_limit` the live-grant cap). */
export class EngineBrokerInferenceGrantRefused extends Error {
  constructor(readonly code: EngineBrokerInferenceFailureCode) { super(`engine broker inference grant refused (${code})`); }
}

/**
 * What the organization runtime asks of a brokered turn beyond the prompt:
 * `limits` may only lower the registration's declared limits, and `model`,
 * when the agent declared one, must equal the model the broker sealed.
 */
export type EngineBrokerTurnOptions = Readonly<{
  limits?: EngineBrokerTurnLimitOverrides; model?: string; processClock?: string; slot?: number;
  /** Sealed observation on completion, failure and replay; sink errors never change the turn. */
  onProviderClock?: (observation: GrokBrokerProviderClockObservation) => void;
}>;
export interface EngineBrokerTurnClient { turn(agentId:string,wakeId:string,prompt:string,mcpEndpoint:string,signal?:AbortSignal,options?:EngineBrokerTurnOptions):Promise<string>; }
export class EngineBrokerControlClient implements EngineBrokerTurnClient {
  constructor(
    private readonly socketPath = "/run/daimon-engine-broker/control.sock",
    /** Internal transport seam; the production client always opens the Unix socket. */
    private readonly connect: (path: string) => Socket = (path) => createConnection({ path })
  ) {}
  async ready(): Promise<void> {
    const requestId = randomUUID();
    const socket = this.connect(this.socketPath);
    const decoder = new EngineBrokerFrameDecoder();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error?: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(controlFailure(error));
      };
      socket.once("error", fail);
      socket.once("close", fail);
      socket.once("connect", () => socket.write(encodeEngineBrokerFrame({
        version: ENGINE_BROKER_VERSION, kind: "health", requestId
      })));
      socket.on("data", (chunk) => {
        try {
          for (const value of decoder.push(chunk)) {
            const response = parseEngineBrokerResponse(value);
            if (response.kind !== "ready" || response.requestId !== requestId || settled) throw new Error();
            settled = true;
            socket.destroy();
            resolve();
          }
        } catch (error) { fail(error); }
      });
    });
  }
  /**
   * Evaluator side (organization uid only; the native relay enforces it):
   * borrow the broker credential for one sequential lane of judge or optimizer
   * requests. Refusals reject with {@link EngineBrokerInferenceGrantRefused};
   * a broker that cannot answer rejects with `engine broker unavailable`.
   */
  async requestInferenceGrant(request:Readonly<{model:GrokBrokerModel;reasoningEffort:GrokBrokerReasoningEffort;purpose:GrokInferencePurpose}>):Promise<EngineBrokerInferenceGrant>{
    const response=await this.exchange({version:ENGINE_BROKER_VERSION,kind:"request_inference_grant",requestId:randomUUID(),model:request.model,reasoningEffort:request.reasoningEffort,purpose:request.purpose});
    if(response.kind==="inference_grant_refused")throw new EngineBrokerInferenceGrantRefused(response.code);
    if(response.kind!=="inference_grant"||response.model!==request.model||response.reasoningEffort!==request.reasoningEffort||response.purpose!==request.purpose)throw new Error(`engine broker unavailable (requires control protocol ${ENGINE_BROKER_VERSION})`);
    const {version:_version,kind:_kind,requestId:_requestId,...grant}=response;return grant;
  }
  async releaseInferenceGrant(grantId:string):Promise<boolean>{
    const response=await this.exchange({version:ENGINE_BROKER_VERSION,kind:"release_inference_grant",requestId:randomUUID(),grantId});
    if(response.kind==="inference_grant_refused")throw new EngineBrokerInferenceGrantRefused(response.code);
    if(response.kind!=="inference_grant_released"||response.grantId!==grantId)throw new Error(`engine broker unavailable (requires control protocol ${ENGINE_BROKER_VERSION})`);
    return response.released;
  }
  async resetSlot(slot: number): Promise<void> {
    const response = await this.exchange({ version: ENGINE_BROKER_VERSION, kind: "reset_slot", requestId: randomUUID(), slot: parseEngineBrokerSlot(slot) });
    if (response.kind !== "slot_reset" || response.slot !== slot) throw new Error("engine broker reset unavailable");
  }
  private exchange(request: EngineBrokerInferenceRequest | Extract<EngineBrokerRequest, {kind: "reset_slot"}>): Promise<EngineBrokerInferenceResponse | Extract<EngineBrokerResponse, {kind: "slot_reset"}>> {
    const socket = this.connect(this.socketPath);
    const decoder = new EngineBrokerFrameDecoder();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error?: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(controlFailure(error));
      };
      socket.once("error", fail);
      socket.once("close", fail);
      socket.once("connect", () => socket.write(encodeEngineBrokerFrame(request)));
      socket.on("data", (chunk) => {
        try {
          for (const value of decoder.push(chunk)) {
            const response = parseEngineBrokerResponse(value);
            if (settled || response.requestId !== request.requestId ||
                (response.kind !== "inference_grant" && response.kind !== "inference_grant_released" &&
                 response.kind !== "inference_grant_refused" && response.kind !== "slot_reset")) throw new Error();
            settled = true;
            socket.destroy();
            resolve(response);
          }
        } catch (error) { fail(error); }
      });
    });
  }
  async turn(
    agentId: string, wakeId: string, prompt: string, mcpEndpoint: string,
    signal?: AbortSignal, options: EngineBrokerTurnOptions = {}
  ): Promise<string> {
    const configured = process.env.DAIMON_ENGINE_BROKER_SLOT;
    const slot = options.slot ?? (configured === undefined ? undefined : parseEngineBrokerSlot(/^(0|[1-9][0-9]*)$/u.test(configured) ? Number(configured) : NaN));
    if (slot !== undefined) parseEngineBrokerSlot(slot);
    const turnId = createHash("sha256").update(`${slot === undefined ? "" : `${slot}\0`}${agentId}\0${wakeId}`).digest("hex");
    const requestId = randomUUID();
    const request = {
      version: ENGINE_BROKER_VERSION, kind: "start_turn", requestId, turnId, agentId, wakeId, prompt, mcpEndpoint,
      ...(slot === undefined ? {} : { slot }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.processClock === undefined ? {} : { processClock: options.processClock })
    } as const;
    const socket = this.connect(this.socketPath);
    const decoder = new EngineBrokerFrameDecoder();
    return new Promise<string>((resolve, reject) => {
      let accepted = false;
      let settled = false;
      const fail = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(controlFailure(error));
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        socket.destroy();
      };
      const abort = () => fail();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      socket.once("connect", () => socket.write(encodeEngineBrokerFrame(request)));
      socket.on("data", (chunk) => {
        try {
          for (const value of decoder.push(chunk)) {
            const response = parseEngineBrokerResponse(value);
            if ((response.kind !== "accepted" && response.kind !== "completed" && response.kind !== "failed") ||
                response.requestId !== requestId || response.turnId !== turnId) throw new Error();
            if (response.kind === "accepted") {
              if (accepted) throw new Error();
              accepted = true;
              continue;
            }
            if (!accepted || settled) throw new Error();
            settled = true;
            cleanup();
            if (response.providerClock !== undefined) {
              try { options.onProviderClock?.(response.providerClock); } catch { /* Observation cannot discard a terminal result. */ }
            }
            if (options.model !== undefined && response.model !== options.model) {
              reject(new Error(`engine broker turn used model ${response.model}, not the declared ${options.model}`));
              return;
            }
            if (response.kind === "completed") {
              if (response.cleanupDiagnostic !== undefined) {
                try {
                  console.warn(`daimon: engine broker ${response.cleanupDiagnostic}`);
                } catch {
                  // An operational warning must not discard completed work.
                }
              }
              resolve(response.text);
            } else {
              const limit = response.limitReason === "none" ? "" : `; limit=${response.limitReason}`;
              const detail = response.diagnostic;
              const reason = detail?.reason === undefined ? "" : `; reason=${detail.reason}`;
              const diagnostic = detail === undefined ? "" :
                `; ${detail.stage}/${detail.failureClass}; exit=${detail.exitCode}; signal=${detail.termSignal}${reason}`;
              const cleanupDiagnostic = response.cleanupDiagnostic === undefined ? "" : `; ${response.cleanupDiagnostic}`;
              reject(new Error(
                `engine broker turn failed (${response.code}${limit}${diagnostic}${renderMcpCalls(response.mcpCalls)}${cleanupDiagnostic})`
              ));
            }
          }
        } catch (error) { fail(error); }
      });
      socket.once("error", fail);
      socket.once("close", () => { if (!settled) fail(); });
    });
  }
}

function controlFailure(error: unknown): Error {
  return error instanceof EngineBrokerProtocolMismatch ? error :
    new Error(`engine broker unavailable (requires control protocol ${ENGINE_BROKER_VERSION})`);
}
