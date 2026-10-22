import { taskClockChildEnvironment } from "../../runtime/taskClock.js";
import { engineShellPolicy } from "../../pi/engineShellPolicy.js";

/** Tool children receive the task clock; provider traffic stays on real time. */
export function codexTaskClockArgs(): string[] {
  const env = taskClockChildEnvironment();
  if (Object.keys(env).length === 0) return [];
  return ["-c", `shell_environment_policy=${engineShellPolicy(env)}`];
}
