import type { GatewayEngine } from "./keyTable.js";
import type { RealmBearer, RealmOwner } from "./realmOwner.js";
import type { ResponseUsage } from "./relay.js";

/**
 * One engine as the gateway serves it: a fixed upstream, a closed route list
 * (`"<METHOD> <subpath>"` under `/v1/<engine>`), the realm owner, and how a
 * bearer is put on an upstream request. Engine knowledge lives in the route
 * module that builds this (`codexRoute.ts`, `grokRoute.ts`), never in the server.
 */
export type GatewayRoute = Readonly<{
  engine: GatewayEngine;
  upstreamBaseUrl: string;
  routes: readonly string[];
  /** Whether a query string is relayed; a route that never needs one refuses it. */
  query: boolean;
  owner: RealmOwner<object>;
  applyBearer(headers: Record<string, string>, bearer: RealmBearer<object>): void;
  usageTap(onUsage: (usage: ResponseUsage) => void): (chunk: Uint8Array) => void;
}>;
