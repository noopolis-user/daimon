import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const readJsonFile = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await readFile(filePath, "utf8")) as T;

export const readPiAuth = async (piAuthPath: string): Promise<Record<string, unknown>> => {
  try {
    return await readJsonFile<Record<string, unknown>>(piAuthPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

export const writePiAuth = async (
  piAuthPath: string,
  next: Record<string, unknown>
): Promise<void> => {
  await mkdir(path.dirname(piAuthPath), { recursive: true });
  await writeFile(piAuthPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
};

