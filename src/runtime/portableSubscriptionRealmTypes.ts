import type { PortableEngineKind } from "../engines/descriptors.js";

export type PortableRealmProfile = Readonly<{
  engine: PortableEngineKind;
  title: string;
  contract: Readonly<{ bootstrapMountPath: string; durableMountPath: string; directoryMode: number; fileMode: number; maxCredentialBytes: number }>;
}>;
export type PortableCredentialJournal = Readonly<{
  agent_id: string; promoted_digest?: string; source_digest: string;
  state: "active" | "preparing" | "promoted" | "promoting";
  version: string;
}>;
/** Whole-lifetime authority over the realm credential; the caller zeroes returned bytes. */
export type PortableRealmAuthority = Readonly<{
  read(): Promise<Buffer>;
  replace(bytes: Uint8Array): Promise<void>;
  markStale(): Promise<void>;
  /** Throws once the exclusive lease is gone. */
  assertLive(): void;
}>;
/** Held for life by the auth gateway, its only owner. */
export type PortableSubscriptionRealm = Readonly<{
  authority: PortableRealmAuthority;
  close(): Promise<void>;
}>;
export type PortableSubscriptionRealmOptions = Readonly<{
  bootstrapPath?: string; durablePath?: string; flock?: string; shell?: string;
}>;
