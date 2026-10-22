import { readJsonFile, readPiAuth, writePiAuth } from "./authFiles.js";

export { seedPiOpenAICodexAuthFromCodex, createPiOpenAICodexAuthFromCodexToken } from "../engines/codex/piAuth.js";

interface ClaudeCodeAuthFile {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    refreshToken?: string;
  };
}

export async function seedPiAnthropicAuthFromClaudeCode(input: {
  claudeCredentialsPath: string;
  piAuthPath: string;
}): Promise<void> {
  const claude = await readJsonFile<ClaudeCodeAuthFile>(input.claudeCredentialsPath);
  const access = claude.claudeAiOauth?.accessToken;
  const refresh = claude.claudeAiOauth?.refreshToken;
  const expires = claude.claudeAiOauth?.expiresAt;

  if (!access || typeof expires !== "number") {
    throw new Error(`Claude Code credentials are missing accessToken or expiresAt: ${input.claudeCredentialsPath}`);
  }

  const piAuth = await readPiAuth(input.piAuthPath);
  piAuth.anthropic = refresh
    ? {
        type: "oauth",
        access,
        refresh,
        expires
      }
    : {
        type: "api_key",
        key: access
      };
  await writePiAuth(input.piAuthPath, piAuth);
}

export async function seedPiApiKeyAuth(input: {
  apiKey: string;
  env?: Record<string, string>;
  piAuthPath: string;
  provider: string;
}): Promise<void> {
  if (input.apiKey.length === 0) {
    throw new Error(`API key for ${input.provider} must not be empty`);
  }

  const piAuth = await readPiAuth(input.piAuthPath);
  piAuth[input.provider] = {
    type: "api_key",
    key: input.apiKey,
    ...(input.env ? { env: input.env } : {})
  };
  await writePiAuth(input.piAuthPath, piAuth);
}
