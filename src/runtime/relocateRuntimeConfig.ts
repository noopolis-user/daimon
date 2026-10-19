import { posix } from "node:path";
import { parseOrganizationRuntimeConfig, type OrganizationRuntimeConfig } from "./organizationRuntime.js";

export type RuntimeConfigLocation = Readonly<{
  workspace: string;
  home: string;
  memory: string;
  /** Both paths are explicit: runtime config declares no control-token file. */
  controlToken: Readonly<{ from: string; to: string }>;
}>;

/** Rebase one memory-backed agent's path prefixes, preserving instructions verbatim. */
export function relocateRuntimeConfig(config: OrganizationRuntimeConfig, location: RuntimeConfigLocation): OrganizationRuntimeConfig {
  const parsed = parseOrganizationRuntimeConfig(config);
  const agent = parsed.agents[0];
  if (parsed.agents.length !== 1 || !agent?.memory) throw new TypeError("Relocation requires one memory-backed agent");
  const mappings = [
    [agent.workspacePath, location.workspace],
    [agent.runtimeHomePath, location.home],
    [agent.memory.runtimeHomePath, location.memory],
    [location.controlToken.from, location.controlToken.to]
  ] as const;
  for (const pair of mappings) for (const value of pair) {
    if (typeof value !== "string" || !posix.isAbsolute(value) || posix.normalize(value) !== value || value === "/" || value.endsWith("/") || value.includes("\\") || value.includes("\0")) {
      throw new TypeError("Relocation paths must be canonical absolute POSIX paths other than root");
    }
  }
  // Memory may live below home; the most specific source must own that subtree.
  const ordered = [...mappings].sort(([a], [b]) => b.length - a.length);
  if (new Set(ordered.map(([source]) => source)).size !== ordered.length) throw new TypeError("Relocation source paths must be distinct");
  const relocate = (value: unknown): unknown => {
    if (typeof value === "string") {
      const mapping = ordered.find(([source]) => value === source || value.startsWith(`${source}/`));
      return mapping ? mapping[1] + value.slice(mapping[0].length) : value;
    }
    if (Array.isArray(value)) return value.map(relocate);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "instructions" ? item : relocate(item)]));
    }
    return value;
  };
  return parseOrganizationRuntimeConfig(relocate(parsed));
}
