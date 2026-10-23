# Static engine descriptors

`src/engines/descriptors.ts` is the compiler/trainer inventory. It imports only
static data from `descriptorContracts.ts` and the broker task-clock contract;
loading it never loads a handler, touches credentials, or probes a CLI. A
consumer can serialize `ENGINE_DESCRIPTORS` directly to generate its mirror.
Keep the descriptor-source commit pinned independently of deployed images.

- `ENGINE_IDS` preserves the released configuration-schema order.
  `SORTED_ENGINE_IDS` preserves the manifest/diagnostic order.
- `authKinds`, `auth.method`, and `auth.provider` describe subscription intent.
  Null method/provider means auth is runtime-owned rather than model-declared.
- `auth.staging` distinguishes a portable ingress file, a broker-owned credential
  realm, and a Secret Service realm. `credentialMaterial` describes the agent
  destination; only a portable-file engine has an ingress source there. Broker
  bootstrap and Secret Service unlock sources, paths, modes and bounds are in
  `auth.realm`. `homeDirectory` is relative to the agent runtime home (empty
  means that home itself); `homeEnvironment` selects the native CLI home.
- Portable engines expose `auth.fileName`, modes, `maxCredentialBytes`, and
  `auth.format`. Codex searches a nested token object then the root if absent;
  Grok searches the first matching authority entry and requires a parseable
  expiration string. These are structural refresh checks, not live login probes.
  Pi OAuth bridging additionally needs a nested account id; the broker credential
  reader has its own stricter single-entry/token-length validation.
- `modelSelection` describes organization-runtime declarations. Codex accepts
  any nonblank model string and a closed effort vocabulary. Null defaults mean
  Daimon supplies no CLI override. AGY exposes neither option. Grok accepts
  neither model nor effort, or both from closed lists; a declared pair requires
  the broker. Its defaults apply at legacy v1 broker registration, not config parsing; v2/v3
  registration requires the pair. Declaration flags describe fixed handler
  invariants, not independent feature switches. General string bounds remain in
  the runtime config schema; a consumer may impose a narrower receipt bound.
  `DEFAULT_PI_MODEL` is a separate API-model default, not a Codex CLI default.
- `sandbox` exposes the configurable Codex policy and fixed Grok profile,
  network restriction and deny-path syntax.
  `capabilities` describes runtime mechanisms; `requiredBinaries` describes the
  native prerequisites.
- `broker` is null or the complete existing broker contract, including control
  protocol id, ABI, binaries, identities, paths, worker pins, clock/slot contract,
  turn-limit bounds/defaults, accounting, and inference grants. Worker config
  bytes must still come from the renderer and match those pins.
- `training.subject` declares evaluator-isolation capability: Codex's native
  sandbox, Grok's broker worker, or unsupported for AGY's unconfined built-ins.
  It does not certify a compiler's adapter or receipt format. A compiler can
  support a narrower set. `training.inferenceGrants` exposes evaluator grant
  capability; its models and efforts use the same `modelSelection` vocabulary.

Compiler policy stays with the consumer: default engine, required model
intent, provider/endpoint restrictions, fallbacks, dedicated training logins,
profile selection/writeback, runtime image pins, mount allocation, evaluator
roots, launch receipts, adapter registration, scheduling and budgets chosen
within Daimon's limits. Standalone judge-provider tuning that bypasses Daimon's
runtime/broker is also consumer policy, not a Daimon model guarantee.

The manifest remains v5. Its legacy fields alias this inventory without adding
fields or changing the released bytes/digest. A manifest v6 is a separate change.
Tests compare descriptors with configuration parsing, rendered worker/grant
pins, omitted defaults, limit enforcement, credential readers and isolation
hooks. A transitive AST boundary test rejects executable imports in the static
inventory.
