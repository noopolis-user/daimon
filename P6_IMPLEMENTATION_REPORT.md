# P6 Daimon implementation report

**Verdict: partial acceptance.** Slot routing, clocks, reset, metering serialization,
contracts and documentation are implemented locally. Literal worker-authenticated
control is not implemented; Linux isolation verification and commits remain blocked.
Nothing was pushed. No network fetch, provider/model call or Docker push was made.

## Findings, ordered by severity

- **P1 — caller-identity contract mismatch remains.** The existing native relay
  authenticates organization UID 2000 using SO_PEERCRED; worker UIDs are not control
  clients (`src/runtime/native/engineBrokerLauncherModes.inc:167`). This implementation
  preserves that boundary. It does not add authentication of the calling host as
  a slot-specific worker UID. Its negative tests cover connection-owned cancellation,
  agent/slot binding, and wrong native result UIDs, not a new kernel caller-UID seam
  (`src/runtime/engineBrokerSlotControl.test.ts:47`,
  `src/runtime/grokEngineBrokerSlots.test.ts:123`,
  `src/runtime/grokEngineBrokerSlots.test.ts:202`).
- **P1 — Linux release acceptance remains unverified.** Actual bubblewrap sibling
  denial, libfaketime offsets and kernel peer credentials were not exercised here.
  The offline tests verify the clock files, per-slot config hashes and enforced
  profile requirements; they cannot establish the mount/UID behavior of Spawnfile's
  generated container (`src/runtime/grokBrokerSlot.ts:10`,
  `src/runtime/grokEngineBrokerSlots.test.ts:87`).
- **P2 — requested commits could not be created.** Git failed creating
  `/Users/apresmoi/Documents/noopolis-org/daimon/.git/worktrees/daimon-p6-parallel/index.lock`
  with `Operation not permitted`. Shared Git metadata is outside this session's
  writable sandbox; approval is unavailable. All edits remain uncommitted on
  `feat/parallel-trials`.
- **P2 — upgrade requires draining old work.** New records live under
  `<turnStore>/slot-<i>` and new turn IDs include slot. Old terminal formats remain
  readable, but flat-store records are not migrated automatically. Preserve old
  stores for audit and drain outstanding old-version work before upgrade
  (`src/runtime/grokEngineBroker.ts:113`, `src/runtime/grokEngineBrokerTurn.ts:87`,
  `src/runtime/engineBrokerTurnRegistry.ts:94`).

## Verified implementation evidence

- Registrations and admission use slot; repeated agents are accepted and duplicate
  slots/worker UIDs are refused (`src/runtime/grokEngineBroker.ts:76`,
  `src/runtime/grokEngineBroker.ts:207`, `src/runtime/engineBrokerServiceConfig.ts:83`).
- Clock files are exactly `/run/daimon-engine-broker/task-clock/slot-<i>/faketime`,
  directories 0755 and files 0644, broker-owned. Config pins select the correct
  slot; attestation requires sibling directory denial before launch
  (`src/runtime/grokBrokerSlot.ts:4`, `src/runtime/grokBrokerWorkerConfig.ts:111`,
  `src/runtime/grokEngineBroker.ts:128`).
- Reset refuses an active/nonempty identity, reserves its slot through I/O, resets
  only its clock and turn store, and fences only that slot on failure. Shutdown
  awaits resets before releasing the credential lease
  (`src/runtime/grokEngineBroker.ts:151`, `src/runtime/grokEngineBrokerSlots.test.ts:187`,
  `src/runtime/grokEngineBrokerSlots.test.ts:224`).
- Same-agent concurrent turns retain distinct IDs, offsets, usage/seal rows and
  responses. Resetting one leaves its active sibling unchanged
  (`src/runtime/grokEngineBrokerSlots.test.ts:87`).
- Shared inference/seal rotation and append are serialized per canonical path;
  concurrent rotation tests detect removal of the queue
  (`src/runtime/turnRequestLedger.ts:181`, `src/runtime/turnRequestLedger.test.ts:140`).
- A single unclocked registration still completes without an explicit slot or clock
  writes (`src/runtime/grokEngineBrokerSlots.test.ts:211`).

## Contracts and exact Spawnfile shape

See [the complete JSON and provisioning contract](docs/parallel-broker-slots.md:11).

- Control: `noopolis.daimon.engine-broker.v4`.
- Service: `noopolis.daimon.engine-broker-service.v3`.
- Manifest: `noopolis.daimon.runtime-contract-manifest.v5`.
- Projection: `noopolis.daimon.grok-broker-projection.v3`.
- Clock: `noopolis.daimon.grok-broker-task-clock.v2`.
- Native ABI 2 and artifacts, preflight v2, ledger versions and unclocked worker
  hashes remain unchanged.
- Service v3 uses seven-field `registrations` plus `slotPolicies` entries containing
  `{slot, usageLedgerPath, limits, model}`. Registration fields are exactly
  `{agentId, slot, workerUid, workspace, profilePath, eventsPath, profileSha256}`.
- Manifest digest:
  `sha256:05c1d8999af86640cfc598b634d0b79454cd6adca21fd7deff2b8ea9670dc04f`.

## Verification and uncertainties

**Verified:** 118 distinct targeted tests pass. Seventeen mutation experiments
turned red, including removing worker-result UID validation and reset's empty-UID
check. The cancellation experiment restored global cancellation lookup, removing
the connection-ownership restriction. Typecheck, build, manifest/native/production
closure verification, source-policy checks and whitespace checks pass. All changed
source/test files are below 400 lines. There is no configured lint command.

**Full suite not green:** the bounded run completed with 1,062 passes, 140 failures,
3 cancellations and 11 skips. Socket/Unix-listener EPERM failures dominate. The
20-second bound also timed out build-heavy/long-running files; standalone build
and artifact verification pass. Two stale proxy-clock test hash lookups discovered
there were corrected and their six tests pass. The earlier full attempt stalled
and was stopped. No claim is made that every remaining failure is environmental.

**Dependency limitation:** this worktree reused the existing local installed
node_modules through an ignored symlink. Installed Mneme is 0.1.1 versus locked
0.1.2; Pi, TypeScript and tsx versions match their locks. No sibling implementation
imports were added. A locked-dependency Linux run is still needed. Cross-vendor
model review was not run under the task's no-model-calls constraint.

Reproduce the checks from this workspace with the same local dependencies:

```sh
cd /Users/apresmoi/Documents/noopolis-org/.worktrees/daimon-p6-parallel
test -e node_modules || ln -s /Users/apresmoi/Documents/noopolis-org/daimon/node_modules node_modules
npm run typecheck
node --import tsx --test src/runtime/{grokEngineBrokerSlots,engineBrokerSlotControl,engineBrokerServiceCli,grokBrokerTaskClock,grokBrokerWorkerConfig,grokBrokerProjection,grokEngineBrokerStartup,grokEngineBrokerDispatch,engineBrokerProtocol,engineBrokerTurnRegistry,engineBrokerVersionBoundary,engineBrokerContract,grokEngineBrokerTaskClock,grokSlotPreflightReceipt,turnRequestLedger,engineBrokerSealLedger,grokBrokerProxyClock}.test.ts
node --import tsx --test scripts/scriptSourcePolicy.test.ts
npm run build
npm run verify:contract-manifest
npm run verify:native
npm run verify:production-closure
git diff --check
node --import tsx --test --test-timeout=20000 'src/**/*.test.ts' scripts/scriptSourcePolicy.test.ts
```

=== REPORT COMPLETE ===
