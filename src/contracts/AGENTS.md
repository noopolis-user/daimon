# Data-only contract guide

`src/contracts` owns runtime-neutral constants, schemas, manifest data, and
pure canonicalization used by runtime code and emitted artifacts.

Keep this folder deterministic and free of I/O, environment access, secrets,
process control, runtime orchestration, and Pi-specific types. Contract objects
must remain immutable literal data suitable for canonical JSON emission.
Runtime behavior belongs in `src/runtime/`; Pi integration belongs in `src/pi/`.

Broker task-clock paths and provisioning modes live in `grokBrokerTaskClock.ts`.
Keep the unclocked worker pins unchanged when adding clocked variants. Manifest
v4 / projection v2 / control protocol v3 must be re-vendored together; native
ABI 2 and launcher pins remain unchanged. Shell-policy filter defaults are
shared with direct engines through `shellEnvironmentPolicy.ts`.
