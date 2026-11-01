import { readFile, stat } from "node:fs/promises";
import { startCodexSubscriptionRealm } from "../engines/codex/codexSubscriptionRealm.js";
import { createCodexRealmOwner } from "./codexRealmOwner.js";
import { createCodexRefresh } from "./codexRefresh.js";
import { parseGatewayConfig } from "./config.js";
import { readGatewayKeyTable } from "./keyTable.js";
import { startGatewayServer, type GatewayServer } from "./server.js";

const MAX_CONFIG_BYTES = 65_536;

export type RunningGateway = Readonly<{ server: GatewayServer; stop(): Promise<void> }>;

/** `daimon-runtime gateway --config <path>`: the sole holder of the Codex realm login. */
export async function runGatewayCli(arguments_: readonly string[]): Promise<RunningGateway> {
  if (arguments_.length !== 2 || arguments_[0] !== "--config" || !arguments_[1]) throw new Error("usage: daimon-runtime gateway --config <path>");
  if ((await stat(arguments_[1])).size > MAX_CONFIG_BYTES) throw new Error("gateway config is too large");
  const config = parseGatewayConfig(JSON.parse(await readFile(arguments_[1], "utf8")));
  const keys = await readGatewayKeyTable(config.keyTablePath);
  // Holds the realm's exclusive flock for the gateway's whole life: a second gateway on this login fails here.
  const realm = await startCodexSubscriptionRealm([], {
    ...(config.codex.realmPath === undefined ? {} : { durablePath: config.codex.realmPath }),
    ...(config.codex.bootstrapPath === undefined ? {} : { bootstrapPath: config.codex.bootstrapPath })
  });
  let server: GatewayServer;
  let owner: Awaited<ReturnType<typeof createCodexRealmOwner>>;
  try {
    owner = await createCodexRealmOwner({ authority: realm.authority!, refresh: createCodexRefresh(config.codex.tokenUrl === undefined ? {} : { tokenUrl: config.codex.tokenUrl }) });
    server = await startGatewayServer({ host: config.host, port: config.port, keys, codex: { owner, ...(config.codex.upstreamBaseUrl === undefined ? {} : { upstreamBaseUrl: config.codex.upstreamBaseUrl }) } });
  } catch (error) {
    await realm.close().catch(() => undefined);
    throw error;
  }
  process.stderr.write(`daimon gateway: listening on ${server.url} (${keys.size} agent keys)\n`);
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    owner.close();
    try { await server.close(); } finally { await realm.close(); }
  })();
  const onSignal = (): void => { void stop().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { server, stop };
}
