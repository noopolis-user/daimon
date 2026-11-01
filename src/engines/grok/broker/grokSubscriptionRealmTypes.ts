import type { OrganizationRuntimeAgentConfig } from "../../../runtime/organizationRuntime.js";
import type { PortableRealmAuthority } from "../../../runtime/portableSubscriptionRealmTypes.js";

export type GrokAgent = OrganizationRuntimeAgentConfig & { engine: { kind: "grok" } };

export type GrokCredentialJournal = Readonly<{
  agent_id: string;
  promoted_digest?: string;
  source_digest: string;
  state: "active" | "preparing" | "promoted" | "promoting";
  version: "noopolis.daimon.grok-credential-lease.v1";
}>;

export type GrokSubscriptionRealm = Readonly<{
  withCredential<T>(agent: GrokAgent, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Sole-holder access for the auth gateway, which owns the realm for its lifetime. */
  authority?: PortableRealmAuthority;
  close(): Promise<void>;
}>;

export type GrokSubscriptionRealmOptions = Readonly<{
  bootstrapPath?: string;
  durablePath?: string;
  flock?: string;
  /** @internal deterministic crash-transition test seam. */
  onTransitionForTest?: (stage: "authority_replaced" | "promotion_prepared") => Promise<void> | void;
  shell?: string;
}>;
