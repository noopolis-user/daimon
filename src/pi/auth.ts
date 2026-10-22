import { seedPiOpenAICodexAuthFromCodex as seedCodexPiAuth } from "../engines/codex/piAuth.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const readJsonFile = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await readFile(filePath, "utf8")) as T;

const readPiAuth = async (piAuthPath: string): Promise<Record<string, unknown>> => {
  try {
    return await readJsonFile<Record<string, unknown>>(piAuthPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const writePiAuth = async (
  piAuthPath: string,
  next: Record<string, unknown>
): Promise<void> => {
  await mkdir(path.dirname(piAuthPath), { recursive: true });
  await writeFile(piAuthPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
};



export { createPiOpenAICodexAuthFromCodexToken } from "../engines/codex/piAuth.js";

export async function seedPiOpenAICodexAuthFromCodex(input: { codexAuthPath: string; piAuthPath: string }): Promise<void> {
  await seedCodexPiAuth(input, { readJsonFile, readPiAuth, writePiAuth });
}

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
