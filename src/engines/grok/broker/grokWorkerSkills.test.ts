import assert from "node:assert/strict";
import test from "node:test";

import { GROK_ENGINE_BROKER } from "../../../contracts/runtimeContractManifest.js";
import { GROK_WORKER_SKILLS_LAYOUT, grokWorkerSkillsSha256, parseAgentSkills, renderGrokWorkerSkillsTree, AGENT_SKILLS_BOUNDS } from "./grokWorkerSkills.js";

const skillMd = (name: string, body = "Do the thing.") => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`;
const skills = () => [
  { name: "moltnet", files: [{ path: "SKILL.md", content: skillMd("moltnet") }] },
  { name: "editor", files: [{ path: "references/style.md", content: "Short sentences.\n" }, { path: "SKILL.md", content: skillMd("editor") }] }
];

test("parsing canonicalizes order so equal skill sets digest equally", () => {
  const parsed = parseAgentSkills(skills());
  assert.deepEqual(parsed.map((skill) => skill.name), ["editor", "moltnet"]);
  assert.deepEqual(parsed[0]!.files.map((file) => file.path), ["SKILL.md", "references/style.md"]);
  const reversed = skills().reverse().map((skill) => ({ ...skill, files: [...skill.files].reverse() }));
  assert.equal(grokWorkerSkillsSha256(reversed), grokWorkerSkillsSha256(skills()));
  assert.match(grokWorkerSkillsSha256([]), /^[a-f0-9]{64}$/u);
});

test("any change to a skill's name, path or bytes changes the digest", () => {
  const base = grokWorkerSkillsSha256(skills());
  const edited = skills(); edited[0]!.files[0]!.content = skillMd("moltnet", "Do the thing!");
  const renamed = skills(); renamed[0]!.name = "moltnet-2";
  const moved = skills(); moved[1]!.files[0]!.path = "references/tone.md";
  const added = skills(); added[0]!.files.push({ path: "notes.md", content: "" });
  const dropped = skills().slice(1);
  for (const variant of [edited, renamed, moved, added, dropped]) assert.notEqual(grokWorkerSkillsSha256(variant), base);
  assert.notEqual(grokWorkerSkillsSha256([]), base);
});

test("refuses names, paths and shapes Grok or a filesystem would reinterpret", () => {
  const one = (name: string, files: unknown) => [{ name, files }];
  const md = [{ path: "SKILL.md", content: skillMd("x") }];
  for (const [label, value] of Object.entries({
    "not an array": {},
    "dot name": one(".", md), "dotdot name": one("../../..", md), "hidden name": one(".hidden", md), "slash name": one("a/b", md), "empty name": one("", md),
    "no SKILL.md": one("x", [{ path: "README.md", content: "" }]), "no files": one("x", []),
    "traversal path": one("x", [...md, { path: "../escape.md", content: "" }]), "absolute path": one("x", [...md, { path: "/etc/passwd", content: "" }]),
    "empty component": one("x", [...md, { path: "a//b.md", content: "" }]), "hidden file": one("x", [...md, { path: ".env", content: "" }]),
    "backslash": one("x", [...md, { path: "a\\b.md", content: "" }]),
    "duplicate path": one("x", [...md, ...md]), "file and directory collide": one("x", [...md, { path: "ref", content: "" }, { path: "ref/a.md", content: "" }]),
    "duplicate skill": [...one("x", md), ...one("x", md)], "extra member": [{ name: "x", files: md, mode: 0o777 }],
    "file extra member": one("x", [{ ...md[0], mode: 0o777 }]), "binary-unsafe content": one("x", [{ path: "SKILL.md", content: "\ud800" }]),
    "too deep": one("x", [...md, { path: Array.from({ length: AGENT_SKILLS_BOUNDS.depth + 1 }, () => "d").join("/"), content: "" }]),
    "file too large": one("x", [{ path: "SKILL.md", content: "x".repeat(AGENT_SKILLS_BOUNDS.fileBytes + 1) }]),
    "too many skills": Array.from({ length: AGENT_SKILLS_BOUNDS.skills + 1 }, (_, index) => ({ name: `s${index}`, files: md }))
  })) assert.throws(() => parseAgentSkills(value), /invalid agent skills/u, label);
});

test("renders root-owned read-only directories before the files they hold, and nothing for no skills", () => {
  const layout = GROK_WORKER_SKILLS_LAYOUT;
  assert.deepEqual(layout, { relativePath: "skills", uid: 0, gid: 0, directoryMode: 0o555, fileMode: 0o444, digestVersion: "noopolis.daimon.grok-worker-skills.v1" });
  const tree = renderGrokWorkerSkillsTree(skills());
  assert.deepEqual(tree.map((entry) => [entry.kind, entry.path, entry.uid, entry.gid, entry.mode.toString(8)]), [
    ["directory", "skills", 0, 0, "555"],
    ["directory", "skills/editor", 0, 0, "555"],
    ["file", "skills/editor/SKILL.md", 0, 0, "444"],
    ["directory", "skills/editor/references", 0, 0, "555"],
    ["file", "skills/editor/references/style.md", 0, 0, "444"],
    ["directory", "skills/moltnet", 0, 0, "555"],
    ["file", "skills/moltnet/SKILL.md", 0, 0, "444"]
  ]);
  assert.equal(tree.find((entry) => entry.path === "skills/moltnet/SKILL.md")?.content, skillMd("moltnet"));
  for (const entry of tree) {
    const parent = entry.path.split("/").slice(0, -1).join("/");
    if (parent !== "") assert.ok(tree.findIndex((other) => other.path === parent) < tree.indexOf(entry), entry.path);
  }
  assert.deepEqual(renderGrokWorkerSkillsTree([]), []);
});

test("the skills layout stays out of the digest-pinned runtime contract manifest", () => {
  assert.equal(Object.hasOwn(GROK_ENGINE_BROKER.worker.home, "skillsDirectory"), false);
  assert.equal(JSON.stringify(GROK_ENGINE_BROKER).includes("grok-worker-skills"), false);
});

test("refusals name the offending skill-relative path", () => {
  const md = { path: "SKILL.md", content: "x" };
  assert.throws(() => parseAgentSkills([{ name: "editor", files: [md, { path: "references/../escape.md", content: "" }] }]), /path "editor\/references\/\.\.\/escape\.md"/u);
  assert.throws(() => parseAgentSkills([{ name: "editor", files: [md, { path: ".env", content: "" }] }]), /"editor\/\.env"/u);
  assert.throws(() => parseAgentSkills([{ name: "../up", files: [md] }]), /skill name "\.\.\/up"/u);
  assert.throws(() => parseAgentSkills([{ name: "editor", files: [md, { path: "a.md", content: 1 }] }]), /file "editor\/a\.md"/u);
});
