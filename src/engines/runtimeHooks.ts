import type { CliEngineOptions } from "../pi/cliSession.js";
import type { PiWakeEnvironmentContextRef } from "../pi/piAgentWakeSupport.js";
import type { OrganizationRuntimeAgentConfig, OrganizationRuntimeConfig } from "../runtime/organizationRuntime.js";
import type { EngineReadiness } from "../runtime/engineReadiness.js";
import type { OrganizationRuntimePathAuthority } from "../runtime/physicalReadiness.js";
import type { AgySubscriptionRealm } from "./agy/agySubscriptionRealm.js";
import type { EngineBrokerControlClient, EngineBrokerTurnClient } from "./grok/broker/engineBrokerControlClient.js";

export type RuntimeDirectoryEntry = Readonly<{ uid: number; gid: number; mode: number }>;
export type RuntimeDirectoryIdentity = Readonly<{ uid: number; gid: number; firstWorkerUid?: number }>;

export type RuntimeHostResources = { agyRealm?: AgySubscriptionRealm; grokBroker?: EngineBrokerControlClient };
export type RuntimeSandbox = Readonly<{
  verifyGrokSandbox?: () => Promise<void>;
  codexSandboxPaths?: { readonly protectedPaths: readonly string[]; readonly readablePaths: readonly string[] };
}>;
export type RuntimeSessionContext = Readonly<{
  agent: OrganizationRuntimeAgentConfig;
  engineHomePath: string;
  agyBusAddress?: string;
  grokBroker?: EngineBrokerTurnClient;
  wakeEnvironmentContext: PiWakeEnvironmentContextRef;
  sandbox: RuntimeSandbox;
}>;
export type RuntimeSandboxContext = Readonly<{
  agent: OrganizationRuntimeAgentConfig;
  readiness: EngineReadiness;
  paths?: ReturnType<OrganizationRuntimePathAuthority["forAgent"]>;
  organizationAgents?: readonly OrganizationRuntimeAgentConfig[];
  sharedProtectedPaths: readonly string[];
}>;

export type EngineCliAuthCommand = Readonly<{ configPath: string; kind: "agy-login" }>;

/** Runtime authority and provider behavior used by the generic host. */
export interface RuntimeEngineHooks {
  readonly cliCommandKind?: EngineCliAuthCommand["kind"];
  parseCliArguments?(arguments_: readonly string[]): EngineCliAuthCommand | undefined;
  runCliCommand?(config: OrganizationRuntimeConfig): Promise<void>;
  readonly runtimeHomeShape: "private" | "worker-traversable";
  assertRuntimeHomeDirectory?(entry: RuntimeDirectoryEntry, label: string, runtime: RuntimeDirectoryIdentity): void;
  /** Preserve credential materialization, broker readiness, then realm startup order. */
  readonly hostReadinessOrder: number;
  prepareHostReadiness(agents: readonly OrganizationRuntimeAgentConfig[], paths: OrganizationRuntimePathAuthority, resources: RuntimeHostResources): Promise<void>;
  assertRuntimeLaunch(agent: OrganizationRuntimeAgentConfig, broker: EngineBrokerTurnClient | undefined): void;
  prepareRuntimeReadiness(agent: OrganizationRuntimeAgentConfig, busAddress: string | undefined, broker: EngineBrokerTurnClient | undefined): Promise<EngineReadiness>;
  runtimeSandbox(context: RuntimeSandboxContext): RuntimeSandbox;
  runtimeSessionOptions(context: RuntimeSessionContext): Partial<CliEngineOptions>;
  runtimeToolName(name: string): string;
  mountedToolNamingRule(names: readonly string[]): string;
  runtimeHarnessToolNames(agent: OrganizationRuntimeAgentConfig): readonly string[] | undefined;
}

export const bareMountedToolNamingRule = (names: readonly string[]): string =>
  `Your mounted tools are exactly: ${names.join(", ")}. Call them by these names; your instructions may spell them differently.`;
