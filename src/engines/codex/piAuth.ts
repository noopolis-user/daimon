import { readJsonFile, readPiAuth, writePiAuth } from "../../pi/authFiles.js";

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
}): Promise<void> {
  const codex = await readJsonFile<CodexAuthFile>(input.codexAuthPath);
  const access = codex.tokens?.access_token;
  const refresh = codex.tokens?.refresh_token;
  const accountId = codex.tokens?.account_id;

  if (!access || !refresh || !accountId) {
    throw new Error(`Codex auth file is missing access_token, refresh_token, or account_id: ${input.codexAuthPath}`);
  }

  const piAuth = await readPiAuth(input.piAuthPath);
  piAuth["openai-codex"] = {
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
    "openai-codex": {
      type: "oauth",
      access: input.access,
      refresh: input.refresh,
      expires: resolveExpires(input.access),
      ...(input.accountId ? { accountId: input.accountId } : {})
    }
  };
}
