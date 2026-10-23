import { ENGINE_DESCRIPTORS } from "../descriptors.js";
type PiAuthFiles = Readonly<{
  readJsonFile<T>(filePath: string): Promise<T>;
  readPiAuth(filePath: string): Promise<Record<string, unknown>>;
  writePiAuth(filePath: string, next: Record<string, unknown>): Promise<void>;
}>;

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const resolveExpires = (accessToken: string): number => {
  const payload = decodeJwtPayload(accessToken);
  const exp = payload?.exp;
  return typeof exp === "number" ? exp * 1000 : Date.now() + 30 * 60 * 1000;
};

export async function seedPiOpenAICodexAuthFromCodex(input: {
  codexAuthPath: string;
  piAuthPath: string;
}, { readJsonFile, readPiAuth, writePiAuth }: PiAuthFiles): Promise<void> {
  const codex = await readJsonFile<CodexAuthFile>(input.codexAuthPath);
  // Pi OAuth bridging requires account_id in the native nested token format.
  // The portable refreshability probe also accepts legacy root-level aliases.
  const access = codex.tokens?.access_token;
  const refresh = codex.tokens?.refresh_token;
  const accountId = codex.tokens?.account_id;

  if (!access || !refresh || !accountId) {
    throw new Error(`Codex auth file is missing access_token, refresh_token, or account_id: ${input.codexAuthPath}`);
  }

  const piAuth = await readPiAuth(input.piAuthPath);
  piAuth[ENGINE_DESCRIPTORS.codex.piProvider] = {
    type: "oauth",
    access,
    refresh,
    expires: resolveExpires(access),
    accountId
  };
  await writePiAuth(input.piAuthPath, piAuth);
}

export function createPiOpenAICodexAuthFromCodexToken(input: {
  access: string;
  accountId?: string;
  refresh: string;
}): Record<string, unknown> {
  return {
    [ENGINE_DESCRIPTORS.codex.piProvider]: {
      type: "oauth",
      access: input.access,
      refresh: input.refresh,
      expires: resolveExpires(input.access),
      ...(input.accountId ? { accountId: input.accountId } : {})
    }
  };
}
