import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

import { ENGINE_IDS } from "./descriptors.js";

const root = path.resolve(import.meta.dirname, "..");
// This released artifact embeds provider contract data until the next contract version.
const allowlist = new Set(["contracts/runtimeContractManifest.ts"]);
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? files(path.join(directory, entry.name))
    : entry.isFile() ? [path.join(directory, entry.name)] : []);

test("engine-id literals stay inside engine implementations", () => {
  const violations: string[] = [];
  for (const file of files(root)) {
    const relative = path.relative(root, file);
    if (relative.startsWith(`engines${path.sep}`) || relative.split(path.sep).includes("fixtures")
      || /\.(?:test|vitest)\.[cm]?[jt]s$/u.test(file) || allowlist.has(relative)
      || !/\.[cm]?[jt]s$/u.test(file)) continue;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        && (ENGINE_IDS as readonly string[]).includes(node.text)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        violations.push(`${relative}:${line}: ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
