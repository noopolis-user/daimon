import { spawnRealTime as spawn, type ChildProcess } from "../runtime/taskClockProcess.js";

import { readChild } from "./cliChildOutput.js";
import { terminateChild, trackCliChild } from "./cliProcess.js";

/**
 * Per-wake MCP endpoint registration for the CLI engines that cannot take the
 * endpoint on their own command line.
 *
 * Codex takes `-c mcp_servers.daimon.url=<endpoint>` per invocation and needs
 * nothing here. AGY is config-file driven, so Daimon registers the ephemeral
 * endpoint before the turn and removes it afterwards through its own `mcp
 * add`/`mcp remove` subcommands. Grok never spawns here: every Grok turn runs
 * through the engine broker.
 *
 * The registration is deliberately performed by the engine CLI rather than by
 * writing its config file directly: the file format belongs to the engine, and
 * a format change absorbed by `mcp add` would silently disable every tool if
 * Daimon hand-wrote it instead.
 */
export type CliMcpRegistration = Readonly<{ close: () => Promise<void> }>;

export type CliMcpRegistrationInput = Readonly<{
  addArgs: readonly string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  failureClassifier?: (diagnostic: string) => Error | undefined;
  onChild: (child: ChildProcess) => void;
  onChildSettled: (child: ChildProcess) => void;
  removeArgs: readonly string[];
  secretValues: readonly string[];
  verify?: () => Promise<void>;
}>;

/**
 * `swept` decides whether the session's dispose path may kill this child.
 *
 * The *add* is swept: a dispose that arrives while the endpoint is still being
 * registered should tear that child down with everything else. The *remove* is
 * deliberately not, because dispose is precisely the caller that is waiting on
 * it to finish — sweeping it makes the session terminate the cleanup it is
 * awaiting, and the resulting `CLI engine exited SIGTERM` is then reported as a
 * failed `stop()` for a wake that was cancelled on purpose. It stays bounded
 * without the sweep: `readChild`'s 30s deadline aborts and terminates it, and
 * `trackCliChild` still owns it for process exit.
 */
const runRegistrationCommand = async (
  input: CliMcpRegistrationInput,
  args: readonly string[],
  swept: boolean
): Promise<void> => {
  const child = trackCliChild(spawn(input.command, args, {
    cwd: input.cwd,
    env: input.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  }));
  if (swept) input.onChild(child);
  try {
    await readChild(child, 30_000, input.secretValues, {
      ...(input.failureClassifier === undefined ? {} : { failureClassifier: input.failureClassifier })
    });
  } finally {
    // An engine CLI may let an auxiliary process outlive its leader. Do not
    // release the tracked setup child until its detached group is quiescent.
    await terminateChild(child);
    if (swept) input.onChildSettled(child);
  }
};

/**
 * Registers the endpoint, returning a single-shot remover.
 *
 * `verify` is the caller's production authority; it runs before both the add
 * and the remove so a registration can never be issued against an unverified
 * engine.
 */
export const registerCliMcpServer = async (
  input: CliMcpRegistrationInput
): Promise<CliMcpRegistration> => {
  await input.verify?.();
  await runRegistrationCommand(input, input.addArgs, true);
  let closePromise: Promise<void> | undefined;
  return {
    close: (): Promise<void> => closePromise ??= (async () => {
      await input.verify?.();
      await runRegistrationCommand(input, input.removeArgs, false);
    })()
  };
};

/** The MCP server name every CLI engine registers Daimon's per-wake endpoint under. */
export const DAIMON_MCP_SERVER_NAME = "daimon" as const;

export { renderAgyMcpAddArgs, renderAgyMcpRemoveArgs } from "../engines/agy/piMcpRegistration.js";
