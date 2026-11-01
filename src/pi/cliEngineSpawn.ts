import { spawnRealTime as spawn, type ChildProcess } from "../runtime/taskClockProcess.js";
import { getEngineHandler } from "../engines/registry.js";
import { trackCliChild } from "./cliProcess.js";
import { cliChildEnvironment } from "./cliEnvironment.js";
import type { CliEngineOptions, CliSessionInput } from "./cliSession.js";

export { renderCodexArgs, renderCodexPermissionProfile } from "../engines/codex/piArgs.js";
export { renderAgyArgs } from "../engines/agy/piArgs.js";

export const spawnEngine = (
  options: CliEngineOptions,
  prompt: string,
  input: CliSessionInput,
  endpoint: string | undefined,
  wakeId?: string
): ChildProcess => {
  const handler = getEngineHandler(options.engine);
  const env = cliChildEnvironment([
    ...(options.redactedEnvironmentNames ?? []),
    ...(input.daimonSecretEnvironmentNames ?? [])
  ], input.runtimeHomePath, {
    ...handler.environmentIntent(options),
    engine: options.engine,
    executablePath: options.command,
    engineHomePath: options.engineHomePath,
    wakeId
  });
  const plan = handler.spawnPlan(options, prompt, input, endpoint);
  const child = trackCliChild(spawn(options.command ?? options.engine, plan.args, {
    cwd: input.cwd, env, detached: process.platform !== "win32",
    stdio: [plan.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
  }));
  if (plan.stdin !== undefined) {
    child.stdin!.on("error", () => undefined);
    child.stdin!.write(plan.stdin); child.stdin!.end();
  }
  return child;
};
