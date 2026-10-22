import type { OrganizationRuntimeEngineIntent } from "../runtime/organizationRuntime.js";

export type EngineConfigRecord = Record<string, unknown>;
export type EngineConfigParsers = Readonly<{
  object(value: unknown, label: string): EngineConfigRecord;
  string(value: unknown, label: string): string;
  nonEmpty(value: unknown, label: string): string;
  exact(value: EngineConfigRecord, expected: readonly string[], label: string): void;
}>;
export interface ConfigEngineHooks {
  parseConfig(input: EngineConfigRecord, label: string, parsers: EngineConfigParsers): OrganizationRuntimeEngineIntent;
}
