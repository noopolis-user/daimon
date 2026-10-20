import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { readAgentSkillsDirectory } from "./agentSkillsDirectory.js";
import { AGENT_SKILLS_WORKSPACE_DIRECTORY, grokWorkerSkillsSha256, renderGrokWorkerSkillsTree } from "./grokWorkerSkills.js";

const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody of ${name}.\n`;
const scratch = async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-skills-dir-"));
  t.after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });
  return root;
};
/** Read-only rendered trees cannot be removed until their directories are writable again. */
const writable = async (directory: string): Promise<void> => {
  const entry = await lstat(directory).catch(() => undefined);
  if (entry === undefined || !entry.isDirectory()) return;
  await chmod(directory, 0o755);
  for (const child of await readdir(directory)) await writable(path.join(directory, child));
};

/** The tree Spawnfile compiles for every Daimon agent: `<workspace>/.agents/skills/<name>/SKILL.md`. */
const compiledWorkspace = async (root: string) => {
  const skills = path.join(root, "workspace", AGENT_SKILLS_WORKSPACE_DIRECTORY);
  await mkdir(path.join(skills, "editor", "references"), { recursive: true });
  await mkdir(path.join(skills, "moltnet"), { recursive: true });
  await writeFile(path.join(skills, "editor", "SKILL.md"), skillMd("editor"));
  await writeFile(path.join(skills, "editor", "references", "style.md"), "Short sentences.\n");
  await writeFile(path.join(skills, "moltnet", "SKILL.md"), skillMd("moltnet"));
  return skills;
};

test("reads the compiled workspace skills tree into the engine-neutral input", async (t) => {
  const skills = await compiledWorkspace(await scratch(t));
  assert.deepEqual(await readAgentSkillsDirectory(skills), [
    { name: "editor", files: [{ path: "SKILL.md", content: skillMd("editor") }, { path: "references/style.md", content: "Short sentences.\n" }] },
    { name: "moltnet", files: [{ path: "SKILL.md", content: skillMd("moltnet") }] }
  ]);
  assert.equal(await readAgentSkillsDirectory(path.join(skills, "missing")), undefined);
});

test("a rendered tree reads back to the digest it was rendered from", async (t) => {
  const root = await scratch(t);
  const input = await readAgentSkillsDirectory(await compiledWorkspace(root));
  const home = path.join(root, "grok-home");
  const tree = renderGrokWorkerSkillsTree(input!);
  for (const entry of tree) {
    if (entry.kind === "directory") await mkdir(path.join(home, entry.path), { recursive: true });
    else await writeFile(path.join(home, entry.path), entry.content!, { mode: entry.mode });
  }
  for (const entry of [...tree].reverse()) if (entry.kind === "directory") await chmod(path.join(home, entry.path), entry.mode);
  const readBack = await readAgentSkillsDirectory(path.join(home, "skills"), { ownerUid: process.getuid!(), readOnly: true });
  assert.equal(grokWorkerSkillsSha256(readBack!), grokWorkerSkillsSha256(input!));
});

test("refuses links, special entries, foreign owners, writable entries and non-UTF-8 bytes rather than skipping them", async (t) => {
  const cases: Record<string, (skills: string) => Promise<void>> = {
    "symlinked file": async (skills) => { await symlink("/etc/hosts", path.join(skills, "editor", "hosts.md")); },
    "symlinked skill": async (skills) => { await symlink(path.join(skills, "editor"), path.join(skills, "alias")); },
    "stray root file": async (skills) => { await writeFile(path.join(skills, "README.md"), "x"); },
    "skill without SKILL.md": async (skills) => { await mkdir(path.join(skills, "empty")); await writeFile(path.join(skills, "empty", "notes.md"), "x"); },
    "non-UTF-8 content": async (skills) => { await writeFile(path.join(skills, "editor", "blob.md"), Buffer.from([0xff, 0xfe, 0x00])); }
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const skills = await compiledWorkspace(await scratch(t));
    await mutate(skills);
    await assert.rejects(readAgentSkillsDirectory(skills), /invalid agent skills/u, label);
  }
  const skills = await compiledWorkspace(await scratch(t));
  await assert.rejects(readAgentSkillsDirectory(skills, { ownerUid: process.getuid!() + 1 }), /unexpected owner/u);
  await assert.rejects(readAgentSkillsDirectory(skills, { ownerUid: process.getuid!(), readOnly: true }), /writable or linked/u);
  const linked = await compiledWorkspace(await scratch(t));
  await link(path.join(linked, "moltnet", "SKILL.md"), path.join(linked, "..", "hardlink.md"));
  for (const directory of ["", "editor", "editor/references", "moltnet"]) await chmod(path.join(linked, directory), 0o555);
  for (const file of ["editor/SKILL.md", "editor/references/style.md", "moltnet/SKILL.md"]) await chmod(path.join(linked, file), 0o444);
  await assert.rejects(readAgentSkillsDirectory(linked, { ownerUid: process.getuid!(), readOnly: true }), /writable or linked/u);
});
