import type { ChildProcess } from "node:child_process";

/** A pipe may split even this six-byte lease handshake across reads. */
export function waitForSubscriptionLeaseReady(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let received = "";
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.stdout?.off("data", data);
      child.off("close", failed);
      child.off("error", failed);
      if (error === undefined) resolve(); else reject(error);
    };
    const failed = (): void => finish(new Error("subscription lease stopped before readiness"));
    const data = (chunk: Buffer): void => {
      received += chunk.toString("utf8");
      if (!"ready\n".startsWith(received)) finish(new Error("subscription lease response invalid"));
      else if (received === "ready\n") finish();
    };
    const timer = setTimeout(() => finish(new Error("subscription lease startup timed out")), timeoutMs);
    child.stdout?.on("data", data);
    child.once("close", failed);
    child.once("error", failed);
    if (child.exitCode !== null || child.signalCode !== null) failed();
  });
}
