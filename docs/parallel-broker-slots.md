# Parallel broker slots (P6)

The control protocol is `noopolis.daimon.engine-broker.v4`, service configuration
is `noopolis.daimon.engine-broker-service.v3`, runtime manifest is
`noopolis.daimon.runtime-contract-manifest.v6`, projection is
`noopolis.daimon.grok-broker-projection.v3`, and the clock contract is
`noopolis.daimon.grok-broker-task-clock.v2`. Native ABI **2**, native artifacts,
preflight receipt **v2**, and usage/request/seal ledger versions are unchanged.
Re-vendor the emitted manifest and digest together with the package.

## Exact service configuration

This two-slot example is the JSON shape Spawnfile must render. Substitute the
real canonical paths and profile digests. `inferenceLedgerPath` is optional;
omitting it disables evaluator grants. Array order has no routing meaning.

```json
{
  "version": "noopolis.daimon.engine-broker-service.v3",
  "credentialHome": "/var/lib/spawnfile/daimon/grok-subscription-realm",
  "turnStore": "/var/lib/spawnfile/daimon/grok-subscription-realm/turns",
  "inferenceLedgerPath": "/run/training/inference/inference.jsonl",
  "registrations": [
    {
      "agentId": "tinkerton",
      "slot": 0,
      "workerUid": 2200,
      "workspace": "/run/training/slot-0/workspace",
      "profilePath": "/var/lib/daimon-workers/2200/.grok/sandbox.toml",
      "eventsPath": "/var/lib/daimon-workers/2200/.grok/sessions/sandbox-events.jsonl",
      "profileSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    {
      "agentId": "tinkerton",
      "slot": 1,
      "workerUid": 2201,
      "workspace": "/run/training/slot-1/workspace",
      "profilePath": "/var/lib/daimon-workers/2201/.grok/sandbox.toml",
      "eventsPath": "/var/lib/daimon-workers/2201/.grok/sessions/sandbox-events.jsonl",
      "profileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  ],
  "slotPolicies": [
    {
      "slot": 0,
      "usageLedgerPath": "/run/training/slot-0/usage/usage.jsonl",
      "limits": { "maxRequests": 24, "maxTokens": 400000, "timeoutMs": 480000 },
      "model": { "id": "grok-4.6", "reasoningEffort": "low" }
    },
    {
      "slot": 1,
      "usageLedgerPath": "/run/training/slot-1/usage/usage.jsonl",
      "limits": { "maxRequests": 24, "maxTokens": 400000, "timeoutMs": 480000 },
      "model": { "id": "grok-4.6", "reasoningEffort": "low" }
    }
  ]
}
```

Each registration has **exactly** `{agentId, slot, workerUid, workspace,
profilePath, eventsPath, profileSha256}`. Native registration JSON uses that same
entry shape. Its binary lowering and ABI do not change. Every registration has
exactly one policy, matched by `slot`. Duplicate slots or worker UIDs are
refused; agent IDs may repeat. Subject ledger directories must be distinct;
inference may not share any usage, request or seal file. No caller-selected
clock path, executable, environment map or reset path is accepted.

Service v1/v2 retain their previous JSON shapes and unique-agent semantics.
Unclocked worker bytes remain unchanged. A v4 start request may omit `slot`
only when that agent has exactly one registration; repeated-agent callers must
send it. Use a matching v4 client; older wire versions are refused explicitly.

## Clock provisioning and isolation

For every slot `i`, provision
`/run/daimon-engine-broker/task-clock/slot-<i>` as broker-owned **0755**, containing
`faketime` with `+0\n`, broker-owned **0644**. Owner UID is 2100. Keep ancestors
canonical, non-symlink, searchable and not worker-writable. The broker writes
only that slot's file, with atomic rename and file/directory sync.

Render `renderGrokBrokerWorkerConfig(policy, "clocked", i)` and install those
bytes root-owned, read-only. Its `FAKETIME_TIMESTAMP_FILE` is exactly
`/run/daimon-engine-broker/task-clock/slot-<i>/faketime`; preload remains shell-only.
`grokBrokerWorkerConfigSha256(policy, "clocked", i)` and the projection's
`workerConfigSha256` identify those bytes. Manifest `clockedConfigSha256` pins
**slot zero's template**; the broker verifies that pin before deriving any other
slot's digest. Manifest unclocked hashes remain unchanged.

In each worker's bubblewrap view, expose its **directory**, never an individual
file inode. Add every sibling slot's **clock directory** to that slot's
`denyPaths`, alongside all existing protected paths. Pass those same denies to
`resolveOrganizationGrokBrokerProjection`, render the sandbox profile, and pin
its digest. The strict base exposes `/run`; its directory deny mounts hide the
siblings. A clocked profile exposing a sibling or masking its own clock is
refused both at startup and before launching a turn. The broker checks the
kernel ProfileApplied event against that exact profile before forwarding spend.
Provision every deny target before preflight; a missing/unplaceable target is
not an acceptable mask. The projection's `taskClock.directoryPath` and
`timestampFilePath` are the selected slot's actual paths.

Startup leases the credential realm, attests and reconciles each discovered
clock separately, and verifies its worker identity is empty before resetting.
Turn cleanup resets only that turn's slot. A cleanup failure fences that slot;
other slots remain independently dispatchable. Aggregate health reports a
fence until successful reset or restart.

## Control and recycling

The caller remains the **trusted organization runtime, UID 2000**. The native
relay checks `SO_PEERCRED` and workers cannot connect to control or backend
sockets. Worker UIDs are execution identities, not authorized control clients.
P6 does not add worker-facing control access or trust a JSON `workerUid` claim.
The launcher selects the registered identity by slot; the broker rejects a
result reporting a different worker UID. A connection receives only its own
terminal result and can cancel only its own turn. Provider/MCP capabilities and
turn IDs are separate for each slot, including equal agent and wake IDs.

Set `DAIMON_ENGINE_BROKER_SLOT=<i>` on the slot's trusted Daimon host process, or
pass `{slot: i}` in `EngineBrokerControlClient.turn` options. The environment is
read by the control client, not passed to the provider worker. Start wire shape:

```json
{
  "version": "noopolis.daimon.engine-broker.v4",
  "kind": "start_turn",
  "requestId": "request-1",
  "turnId": "sha256-of-slot-NUL-agentId-NUL-wakeId",
  "slot": 0,
  "agentId": "tinkerton",
  "wakeId": "trial-unique-wake",
  "prompt": "work",
  "mcpEndpoint": "http://127.0.0.1:45001/mcp",
  "processClock": "-843385600.250"
}
```

`limits` may optionally lower declared limits; `processClock` is optional.
Frames retain the existing four-byte big-endian byte length plus JSON encoding.

After closure and collection, call `EngineBrokerControlClient.resetSlot(i)` on
the organization control socket. The exact request and successful response are:

```json
{"version":"noopolis.daimon.engine-broker.v4","kind":"reset_slot","requestId":"reset-1","slot":0}
{"version":"noopolis.daimon.engine-broker.v4","kind":"slot_reset","requestId":"reset-1","slot":0}
```

An active, resetting, unknown or closed slot refuses reset (connection closes;
the client rejects). The reset reserves only that slot, verifies its worker
identity is empty, resets its clock if present, and deletes only
`<turnStore>/slot-<i>`. It does not stop any broker process, abort a sibling,
delete ledgers, or clear the shared inference ledger. A failed reset fences the
selected slot; a successful retry clears its fence. Shutdown waits for resets
before releasing the shared credential lease. Re-provision only after successful
reset; never remove sibling temp directories while their attestations can run.

Use fresh wake IDs across trials/recycles: ledger consumers still deduplicate
by `turn`, and reset intentionally preserves collected metering. V4 stores turn
records under slot directories and hashes slot into new turn identities. Legacy
v1/v2/v3 terminal formats remain readable, but old flat-store records are not
automatically migrated into the new namespace. Drain outstanding old-version
work before upgrading; preserve old records and ledgers for audit.

## Shared request admission

Service v3 accepts an optional positive integer `maxRunRequests`. One proxy-owned
budget reserves and fsyncs capacity before every upstream attempt from any subject
slot or evaluator grant. Credential retries consume another reservation; failures
never refund one. Exhaustion returns `429` with `run_request_limit` without forwarding.
The journal is `<runRequestStore>/run-requests.json`; the optional canonical absolute
`runRequestStore` defaults to `turnStore`. Keep it outside resettable slot stores.
Malformed checkpoints, changed limits and publication failures fail closed. Broker
restart retains the count when the store survives. Spawnfile training retains the
run store in a dedicated volume keyed by the run's output directory, independently
of disposable slot state and the credential realm.

## Verification boundary

Offline tests exercise real control framing/parsing over in-memory transports,
real clock/turn-store/ledger files, concurrent barrier-controlled native-worker
fakes, and attested config/profile policy. Linux `SO_PEERCRED`, bubblewrap mounts,
libfaketime and actual worker identity enforcement require the model-free Linux
release checks in [broker-task-clock.md](broker-task-clock.md), extended to two
simultaneous slots with distinct nonzero offsets and denied sibling reads.
