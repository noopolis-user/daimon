import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import test from "node:test";
import { EngineBrokerControlClient } from "./engineBrokerControlClient.js";
import {
  ENGINE_BROKER_VERSION, EngineBrokerFrameDecoder, encodeEngineBrokerFrame
} from "./engineBrokerProtocol.js";
import { serveEngineBrokerConnection, type EngineBrokerServiceEngine } from "./engineBrokerService.js";

const V2 = "noopolis.daimon.engine-broker.v2";
const V4 = "noopolis.daimon.engine-broker.v4";
const readiness = {
  providerProxyPort: 43123, mcpFacadePort: 43124, registrations: 1,
  credentialStale: false, realmLease: true, workerIsolation: true
} as const;

// The real production client and service run both parsers and all framing.
// Only the Unix transport is replaced, so this works under no-listen sandboxes.
function transport(serve: (socket: Socket) => void): () => Socket {
  return () => {
    const socket = new Duplex({ read() {} });
    const peer = new Duplex({ read() {} });
    socket._write = (chunk, _encoding, done) => { peer.push(chunk); done(); };
    peer._write = (chunk, _encoding, done) => { socket.push(chunk); done(); };
    socket._final = (done) => { peer.push(null); done(); };
    peer._final = (done) => { socket.push(null); done(); };
    socket.once("close", () => peer.destroy());
    peer.once("close", () => socket.destroy());
    serve(peer as Socket);
    queueMicrotask(() => socket.emit("connect"));
    return socket as Socket;
  };
}

// The length-prefixed JSON framing is unchanged from origin/main's v2 client.
function wire(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength);
  return Buffer.concat([header, body]);
}

function exchange(connect: () => Socket, version: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect();
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => socket.destroy(new Error("diagnostic not closed")), 2000);
    socket.once("close", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(wire({ version, kind: "health", requestId: "old-client" })));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

test("the production service sends a bounded version diagnostic to an old client before EOF", async () => {
  let turns = 0;
  const engine: EngineBrokerServiceEngine = {
    readiness: () => readiness, close: async () => {},
    turn: async () => { turns++; throw new Error("must not execute"); }
  };
  const connect = transport((socket) => serveEngineBrokerConnection(socket, engine));
  for (const received of [V2, V4, "secret".repeat(10000), { private: "never reflect" }]) {
    const bytes = await exchange(connect, received);
    assert.ok(bytes.byteLength > 4 && bytes.byteLength <= 256, "bounded diagnostic must reach the socket");
    const frames = new EngineBrokerFrameDecoder().push(bytes);
    assert.deepEqual(frames, [{
      kind: "protocol_mismatch",
      receivedVersion: received === V2 || received === V4 ? received : "<invalid>",
      expectedVersion: ENGINE_BROKER_VERSION
    }]);
  }
  assert.equal(turns, 0);
  // Refusing an incompatible client must not affect a compatible one.
  await new EngineBrokerControlClient("memory", connect).ready();
});

/**
 * Frozen legacy health boundary from origin/main (796b414): v2 validates the
 * version before dispatch and destroys the socket on a parser exception.
 * A v2 broker cannot retroactively emit a diagnostic; v3 names its requirement.
 */
function legacyService(socket: Socket): void {
  socket.on("error", () => socket.destroy());
  const decoder = new EngineBrokerFrameDecoder();
  socket.on("data", (chunk) => {
    try {
      for (const frame of decoder.push(chunk)) {
        const value = frame as { version?: unknown; kind?: unknown; requestId?: unknown };
        if (value.version !== V2 || value.kind !== "health") throw new TypeError("invalid broker frame");
        socket.end(wire({
          version: V2, kind: "ready", requestId: value.requestId, brokerUid: 2100, ...readiness
        }));
      }
    } catch { socket.destroy(); }
  });
}

test("the production client refuses the legacy service and names its required version", async () => {
  const connect = transport(legacyService);
  const oldReady = new EngineBrokerFrameDecoder().push(await exchange(connect, V2));
  assert.equal((oldReady[0] as { kind: string }).kind, "ready", "legacy service really serves v2");
  const client = new EngineBrokerControlClient("memory", connect);
  const required = /requires control protocol noopolis\.daimon\.engine-broker\.v3/u;
  await assert.rejects(client.ready(), required);
  await assert.rejects(client.turn("a", "w", "work", "http://127.0.0.1:1/mcp"), required);
});

test("every production client operation surfaces both versions from a diagnostic frame", async () => {
  const connect = transport((socket) => {
    socket.on("error", () => socket.destroy());
    socket.once("data", () => socket.end(encodeEngineBrokerFrame({
      kind: "protocol_mismatch", receivedVersion: ENGINE_BROKER_VERSION, expectedVersion: V4
    })));
  });
  const client = new EngineBrokerControlClient("memory", connect);
  const mismatch = /protocol version mismatch \(received noopolis\.daimon\.engine-broker\.v3; expected noopolis\.daimon\.engine-broker\.v4\)/u;
  await assert.rejects(client.ready(), mismatch);
  await assert.rejects(client.turn("a", "w", "work", "http://127.0.0.1:1/mcp"), mismatch);
  await assert.rejects(client.requestInferenceGrant({
    model: "grok-4.6", reasoningEffort: "low", purpose: "judge"
  }), mismatch);
  await assert.rejects(client.releaseInferenceGrant("grant"), mismatch);
});
