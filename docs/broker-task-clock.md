# Brokered Grok task clock

The optional clocked worker config shifts native shell children while Daimon,
the native launcher and Grok itself retain real time. It uses the same shell
policy inheritance, empty include/exclude filters and automatic secret-name
exclusions as direct Grok. Its `set` contains exactly four keys:

| Key | Fixed value |
| --- | --- |
| `LD_PRELOAD` | `/usr/local/lib/daimon/libfaketime.so.1` |
| `FAKETIME_TIMESTAMP_FILE` | `/run/daimon-engine-broker/task-clock/faketime` |
| `FAKETIME_DONT_FAKE_MONOTONIC` | `1` |
| `LC_ALL` | `C` |

The two paths are exported as `GROK_BROKER_TASK_CLOCK_PRELOAD_PATH` and
`GROK_BROKER_TASK_CLOCK_FILE_PATH`; ownership/modes live in
`GROK_BROKER_TASK_CLOCK`, also exposed in the manifest's `worker.taskClock`.
No offset is embedded in the config. The existing renderer's default and all
nine `worker.configSha256` pins remain byte-identical to origin/main 796b414.
`renderGrokBrokerWorkerConfig(policy, "clocked")` selects the additional nine
`worker.clockedConfigSha256` pins. Home attestation accepts either exact pin
for the declared model/effort and reports the variant; tampering refuses a turn.

`start_turn.processClock` is an optional signed relative-seconds string with
optional three-digit milliseconds, derived by `taskClockChildEnvironment`.
It carries no path or environment map. Control protocol **v3** refuses v1/v2
wire frames; both ends must upgrade together. Historical v1/v2 sealed turns
still replay. The request digest includes a supplied clock, so changing it
for the same wake is a conflict. A replay never rewrites the clock file.
Native ABI **2**, native argv/environment and launcher artifact pins do not change.

Before native launch, a clocked slot writes the offset plus a newline through
an exclusive temporary file, chmod, fsync and rename. A turn without a clock
writes `+0`. A publication failure prevents launch. An unclocked slot performs
no clock-file I/O, allows the turn, and reports the existing gap when the field
is present. Terminal responses record `shellClock: task|real|gap`; the sealed
`turns.jsonl` projection records `shell_clock`. This records configured shell
coverage, not proof that every command dynamically linked libfaketime.

## Engine-injected date in provider requests

Grok 1.0.34 also injects `Today's date: YYYY-MM-DD` inside a `<user_info>` block
in the first user message. The supplied offline Linux capture shows that this
comes from the real kernel clock; the static CLI ignores libfaketime, and the
system prompt override does not replace this user-message envelope.

For every turn with `processClock` (including `+0`), the broker's provider proxy
rewrites every such line in user-role string content and `type: "text"` content
parts before the existing model/effort/tool gate. It uses `realNow + offset` at
each request, formatted in the launcher's pinned **UTC**, including later
requests that resend history. Other roles, text outside these blocks and
non-text parts retain their content. This works even if shell coverage is `gap`;
it does not shift the CLI, provider TLS, auth, or operational clocks.

A date-like line with a different format refuses the whole request with HTTP
400 reason `task_clock_date_format`, before any upstream call or spend. A task
instant outside the supported 1970–9999 UTC range refuses as
`task_clock_date_range`. A request without the date line is allowed and counted.
Unclocked requests retain their bytes, including whitespace and escaping. The
existing spend gate still normalizes ambiguous duplicate JSON members to the
validated values, and rejects invalid JSON/prototype keys.

Every clocked terminal response seals `providerClock`; `turns.jsonl` projects it
as `provider_clock`, on completed and failed turns and on final-reply recovery:

- `requests`: requests inspected by the clock rewrite, including later refusals.
- `linesRewritten`: recognized lines processed in fully rewritten bodies,
  including a replacement whose date was already equal; body-policy refusals
  can therefore count here without spending upstream.
- `requestsWithoutDateLine`: inspected bodies with no target date line; a
  malformed date refusal is not counted as absence.
- `injectedDate`, `taskDate`: dates from the **last** rewritten line, or both
  `null` until a line is rewritten. No message content or timestamps are stored.

Replays retain the sealed observation without rewriting or recounting. Unclocked
turns and older records have no `providerClock` member. Session-title requests
remain locally refused through their existing sink and are not counted here.
UUIDv7 session/conversation headers are not model context and are outside this
rewrite; the proxy's existing header allowlist is unchanged.

## Spawnfile provisioning

1. Re-vendor manifest **v4**, its emitted digest, the clocked config bytes and
   projection **v2**; build with `npm run build`, then run
   `npm run verify:contract-manifest`. Training projections pass
   `workerConfigVariant: "clocked"`; production keeps the default.
2. Install the architecture's distro libfaketime and create the root-owned
   symlink `/usr/local/lib/daimon/libfaketime.so.1` to that library. Neither the
   symlink, library nor ancestors may be worker-writable. Do not preload the
   broker, launcher or Grok process.
3. Provision `/run/daimon-engine-broker/task-clock` as **2100:2100 0755**,
   initially containing `faketime` with `+0\n`, **2100:2100 0644**. The broker
   verifies the directory and publishes files with those modes even with umask
   077. Every ancestor must be canonical, non-symlink and searchable by the
   worker, with no worker write access; the control root can be root-owned
   0711. Do not change credential-root permissions to expose this file.
4. Keep the whole clock directory visible in the worker's bubblewrap view at
   the exact path above, read-only to the worker. Bind the **directory**, never
   the individual file: rename changes the file inode. The pinned strict base
   exposes `/run` and `/usr`; keep this subtree and the library out of deny
   masks. Verify the distro library's symlink target is visible too.
   `GROK_HOME` remains `<registered home>/.grok` with the existing sticky,
   root-owned layout; the clock is not in a worker-writable home or temp dir.
5. Install the selected clocked `config.toml` **root:root 0444**, and retain
   all existing profile, trust, managed-config and requirements attestations.
   Slot preflight must check the installed config against the projection's
   selected digest, as well as readability and denied writes to the clock.
6. A clock-enabled container has **one worker registration**. The broker refuses
   a clocked config in a multi-registration instance; otherwise a fixed path
   would share offsets across concurrent workers. Each training slot needs
   its own mount namespace and clock directory. Turns for one agent cannot
   overlap. Multi-worker unclocked production instances retain their configs.

## Manual Linux release check — no model calls

This cannot establish Linux behavior on macOS. In a disposable provisioned
training slot, with no worker running, use a shell under the worker uid and
the deployment's actual bubblewrap mounts to verify these assertions:

- The worker reads the broker-published file and cannot write, unlink or
  replace it or its directory. After a broker rename, a fresh reader sees the
  new value, not the inode from a file bind mount.
- Applying exactly the four config variables to `/bin/date -u +%s` with file
  value `-31536000.250` gives real time shifted by that value within five seconds.
  Restore `+0` and check a fresh shell reads real time. Use a nonzero sentinel
  first so a missing library cannot pass a zero-offset check.
- The broker and a process launched with the native worker's fixed environment
  observe real time throughout, and monotonic deadlines remain real.

This tests provisioning and libfaketime. Testing Grok's application of its shell
policy additionally requires the pinned binary against a local scripted provider
stub that requests `run_terminal_command` (CLI id `run_terminal_cmd`); no upstream/model request is needed.
Do not use `live:grok-broker` for this check: that existing script spends provider
quota. Unit tests exercise rendering, pins, attestation, protocol, publication,
reset, gap reporting, observability and replay without model calls.
