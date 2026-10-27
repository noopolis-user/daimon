import type { PortableEngineKind } from "../engines/descriptors.js";

export type PortableRealmAgent = Readonly<{ id: string; runtimeHomePath: string }>;
export type PortableRealmProfile = Readonly<{
  engine: PortableEngineKind;
  title: string;
  contract: Readonly<{ agentCredentialRelativePath: string; bootstrapMountPath: string; durableMountPath: string; directoryMode: number; fileMode: number; maxCredentialBytes: number }>;
  isAuthenticationRejected(error: unknown): boolean;
}>;
export type PortableCredentialJournal = Readonly<{
  agent_id: string; promoted_digest?: string; source_digest: string;
  state: "active" | "preparing" | "promoted" | "promoting";
  version: string;
}>;
export type PortableSubscriptionRealm = Readonly<{
  withCredential<T>(agent: PortableRealmAgent, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  close(): Promise<void>;
}>;
export type PortableSubscriptionRealmOptions = Readonly<{
  bootstrapPath?: string; durablePath?: string; flock?: string; shell?: string;
  /** @internal deterministic crash-transition test seam. */
  onTransitionForTest?: (stage: "authority_replaced" | "promotion_prepared") => Promise<void> | void;
}>;
