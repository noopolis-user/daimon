# Engine implementation guide

Use named exports and an index.ts barrel. Keep source files below 400 lines
and tests beside implementations. Preserve provider behavior and public types.
Static descriptors must not import handlers or runtime implementation.
Broker infrastructure moves preserve its existing protocol and security rules.
