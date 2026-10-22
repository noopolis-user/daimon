import { taskClockChildEnvironment } from "../../runtime/taskClock.js";
import { engineShellPolicy } from "../../pi/engineShellPolicy.js";

export function grokTaskClockConfig(): string {
  const env = taskClockChildEnvironment();
  return Object.keys(env).length === 0 ? "" : `shell_environment_policy = ${engineShellPolicy(env)}\n`;
}
