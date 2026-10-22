import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { ENGINE_IDS } from "./descriptors.js";

const execute = promisify(execFile);

test("handlers and barrels initialize from every isolated import entry point", async () => {
  const entries = ["index", "registry", "grok/broker/index", ...ENGINE_IDS.flatMap((id) =>
    ["index", "piHooks", "runtimeHooks", "authHooks", "configHooks"].map((name) => `${id}/${name}`))];
  for (const entry of entries) {
    const source = `await import(${JSON.stringify(new URL(`./${entry}.ts`, import.meta.url).href)});`
      + `const {getEngineHandler,engineHandlers}=await import(${JSON.stringify(new URL("./registry.ts", import.meta.url).href)});`
      + 'for(const handler of engineHandlers())if(getEngineHandler(handler.id)!==handler)throw Error("unstable handler");'
      + 'process.stdout.write("ENGINE_IMPORT_OK");';
    const result = await execute("env", ["-u", "TYPESAFE_API_KEY", process.execPath, "--import", "tsx", "--input-type=module", "-e", source], {
      cwd: process.cwd(), timeout: 10_000, env: { ...process.env }
    });
    assert.equal(result.stdout, "ENGINE_IMPORT_OK", entry);
  }
});
