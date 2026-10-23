import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

const engines = import.meta.dirname;
const allowed = new Set([
  "descriptors.ts",
  "descriptorContracts.ts",
  "grok/broker/grokBrokerTaskClockContract.ts",
]);

const toTs = (fromFile: string, specifier: string): string => {
  const base = path.resolve(path.dirname(fromFile), specifier);
  return base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : base.endsWith(".ts") ? base : `${base}.ts`;
};

const executable = (node: ts.Node): string | null => {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)
    || ts.isConstructorDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return "executable declaration";
  }
  if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)) return "import-equals or import() type";
  if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) return "call";
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return "dynamic import";
  if (ts.isIdentifier(callee) && callee.text === "require") return "require";
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    && callee.expression.text === "Object" && callee.name.text === "freeze") return null;
  return "call";
};

const specifiers = (source: ts.SourceFile): string[] => {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) found.push(node.moduleReference.expression.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

test("descriptors.ts import closure is handler-free data", () => {
  const violations: string[] = [];
  const seen = new Set<string>();
  const queue = ["descriptors.ts"];
  while (queue.length > 0) {
    const relative = queue.pop();
    if (relative === undefined || seen.has(relative)) continue;
    seen.add(relative);
    if (!allowed.has(relative)) {
      violations.push(`${relative}: outside data closure`);
      continue;
    }
    const file = path.join(engines, relative);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      const reason = executable(node);
      if (reason) violations.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${reason}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of specifiers(source)) {
      if (!specifier.startsWith(".")) {
        violations.push(`${relative}: non-relative ${specifier}`);
        continue;
      }
      const next = path.relative(engines, toTs(file, specifier));
      if (!existsSync(path.join(engines, next))) violations.push(`${relative}: missing ${specifier}`);
      else queue.push(next);
    }
  }
  expect(violations).toEqual([]);
});
