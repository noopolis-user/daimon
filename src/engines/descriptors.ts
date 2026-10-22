/** Static engine inventory. This module must never import executable handlers. */
export const ENGINE_DESCRIPTORS = {
  codex: {
    id: "codex", piAuthMethod: "codex", piProvider: "openai-codex", piSourceProvider: "openai", authKinds: ["subscription"], credentialMaterial: {
      sourceSlot: "codex-auth", sourceRelativePath: ".daimon-inbound/codex-auth",
      destinationRelativePath: ".codex/auth.json", directoryMode: 0o700, fileMode: 0o600
    },
    requiredBinaries: ["codex"], homeDirectory: ".codex", homeEnvironment: "CODEX_HOME",
    capabilities: { portableCredential: true, nativeSandbox: true, broker: false, secretService: false }
  },
  grok: {
    id: "grok", authKinds: ["subscription"], credentialMaterial: { destinationRelativePath: ".grok/auth.json" },
    requiredBinaries: ["grok", "daimon-engine-broker"], homeDirectory: ".grok", homeEnvironment: "GROK_HOME",
    capabilities: { portableCredential: true, nativeSandbox: true, broker: true, secretService: false }
  },
  agy: {
    id: "agy", authKinds: ["subscription"], credentialMaterial: null,
    requiredBinaries: ["agy", "dbus-daemon", "gnome-keyring-daemon"], homeDirectory: "", homeEnvironment: "ANTIGRAVITY_CLI_HOME",
    capabilities: { portableCredential: false, nativeSandbox: false, broker: false, secretService: true }
  }
} as const;
export type EngineKind = keyof typeof ENGINE_DESCRIPTORS;
/** Preserve the released schema order separately from the manifest's sorted order. */
export const ENGINE_IDS = [ENGINE_DESCRIPTORS.codex.id, ENGINE_DESCRIPTORS.grok.id, ENGINE_DESCRIPTORS.agy.id] as const;
export const SORTED_ENGINE_IDS = [ENGINE_DESCRIPTORS.agy.id, ENGINE_DESCRIPTORS.codex.id, ENGINE_DESCRIPTORS.grok.id] as const;
export const PORTABLE_ENGINE_IDS = [ENGINE_DESCRIPTORS.codex.id, ENGINE_DESCRIPTORS.grok.id] as const;
export type PortableEngineKind = typeof PORTABLE_ENGINE_IDS[number];

export const DEFAULT_PI_MODEL = { auth: { method: ENGINE_DESCRIPTORS.codex.piAuthMethod }, provider: "openai", name: "gpt-5.4-mini" } as const;
