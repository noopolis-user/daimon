import { spawnRealTime as spawn } from "../../runtime/taskClockProcess.js";
import { cliChildEnvironment } from "../../pi/cliEnvironment.js";
import type { AuthEngineHooks } from "../authHooks.js";

export const agyAuthHooks: AuthEngineHooks = {
  engineHomePath: (runtimeHomePath) => runtimeHomePath,
  verifyAuth: ({ agentId, executablePath, runtimeHomePath, busAddress }) => verifyAgySubscriptionEnrollment(agentId, executablePath, runtimeHomePath, busAddress),
  hasRefreshableCredential: () => false
};

export async function verifyAgySubscriptionEnrollment(
  agentId: string,
  executablePath: string,
  runtimeHomePath: string,
  busAddress: string | undefined
): Promise<void> {
  if (busAddress === undefined) throw unavailable(agentId, "agy", "Daimon subscription realm is unavailable");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, ["models"], {
      cwd: runtimeHomePath,
      env: cliChildEnvironment([], runtimeHomePath, {
        dbusSessionBusAddress: busAddress,
        engine: "agy",
        executablePath,
        engineHomePath: runtimeHomePath
      }),
      stdio: ["ignore", "ignore", "ignore"]
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("error", () => { clearTimeout(timer); reject(unavailable(agentId, "agy", "native secure-storage authentication probe failed")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(unavailable(agentId, "agy", "subscription enrollment is required; run the Daimon AGY bootstrap command"));
    });
  });
}
function unavailable(agentId: string, engine: string, detail: string): Error { return new Error(`agent ${agentId} ${engine} is unavailable: ${detail}`); }
