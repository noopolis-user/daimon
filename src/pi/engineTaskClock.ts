import { readTaskClock, taskClockChildEnvironment } from "../runtime/taskClock.js";
import { shellEnvironmentPolicyEntries } from "../contracts/shellEnvironmentPolicy.js";

/** Explicit set is scoped by the engines to shell/tool children, never provider traffic.
 * Pin an empty allowlist so ambient include filters cannot discard the clock values.
 * Sources/versions and the broker contract and AGY gap are recorded in docs/runtime.md.
 */
export function codexTaskClockArgs(): string[] {
  const env = taskClockChildEnvironment();
  if (Object.keys(env).length === 0) return [];
  return ["-c", `shell_environment_policy=${shellPolicy(env)}`];
}

export function grokTaskClockConfig(): string {
  const env = taskClockChildEnvironment();
  return Object.keys(env).length === 0 ? "" : `shell_environment_policy = ${shellPolicy(env)}\n`;
}

function shellPolicy(env: Record<string, string>): string {
  return `{${shellEnvironmentPolicyEntries(env).join(",")}}`;
}

/** Operational diagnostic only. Brokered Grok reports from its attested per-turn boundary. */
export function reportEngineTaskClockGap(engine: "codex" | "grok" | "agy"): void {
  if (readTaskClock() === undefined) return;
  const gap = engine === "agy" ? "no supported tool-only environment setting"
    : undefined; // Brokered Grok reports after config attestation, from its per-turn processClock field.
  if (gap) console.warn(`daimon: task clock coverage gap engine=${engine}: ${gap}; native tools remain on real time; wake allowed`);
}
