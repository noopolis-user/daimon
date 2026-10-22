import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod,mkdir,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DurableGrokBrokerCredentialAuthority } from "./grokBrokerCredentialAuthority.js";

test("credential authority resumes only a journal matching durable credential",async()=>{const home=await fixture();try{const bytes=await import("node:fs/promises").then(({readFile})=>readFile(path.join(home,"auth.json"))),digest=createHash("sha256").update(bytes).digest("hex");await journal(home,{state:"promoted",generation:1,sourceDigest:"a".repeat(64),promotedDigest:digest});const authority=new DurableGrokBrokerCredentialAuthority("/usr/local/bin/grok",home);await authority.initialize();assert.equal((await authority.accessToken(false)).length>=32,true);}finally{await rm(home,{recursive:true,force:true});}});

test("credential authority fails closed after indeterminate restart",async()=>{const home=await fixture();try{await journal(home,{state:"refreshing",generation:1,sourceDigest:"b".repeat(64)});const authority=new DurableGrokBrokerCredentialAuthority("/usr/local/bin/grok",home);await assert.rejects(authority.initialize(),/unavailable/u);await assert.rejects(authority.accessToken(false),/unavailable/u);}finally{await rm(home,{recursive:true,force:true});}});

test("stale fence durably records the rejected credential digest and generation for operator recovery",async()=>{const home=await fixture();try{const auth=await readFile(path.join(home,"auth.json")),digest=createHash("sha256").update(auth).digest("hex");await journal(home,{state:"promoted",generation:7,sourceDigest:"a".repeat(64),promotedDigest:digest});const authority=new DurableGrokBrokerCredentialAuthority("/usr/local/bin/grok",home);await authority.initialize();await assert.rejects(authority.markRejected(),/unavailable/u);const observed=JSON.parse(await readFile(path.join(home,".daimon-broker","credential-journal.json"),"utf8")) as Record<string,unknown>;assert.equal(observed.state,"stale");assert.equal(observed.generation,7);assert.equal(observed.sourceDigest,digest);assert.equal(observed.promotedDigest,digest);}finally{await rm(home,{recursive:true,force:true});}});

test("a late rejection cannot stale-fence a newer access token",async()=>{const home=await fixture();try{const authority=new DurableGrokBrokerCredentialAuthority("/usr/local/bin/grok",home);await authority.initialize();const old=createHash("sha256").update("k".repeat(40)).digest("hex");await writeFile(path.join(home,"auth.json"),JSON.stringify({subscription:{key:"n".repeat(40),refresh_token:"r".repeat(20)}}),{mode:0o600});await assert.rejects(authority.markRejected(old),/unavailable/u);assert.equal(authority.isStale(),false);}finally{await rm(home,{recursive:true,force:true});}});

async function fixture():Promise<string>{const home=await mkdtemp(path.join(tmpdir(),"grok-authority-"));const value={subscription:{key:"k".repeat(40),refresh_token:"r".repeat(20),expires_at:"2030-01-01T00:00:00Z"}};await writeFile(path.join(home,"auth.json"),JSON.stringify(value),{mode:0o600});return home;}
async function journal(home:string,value:Record<string,unknown>):Promise<void>{const root=path.join(home,".daimon-broker");await mkdir(root,{mode:0o700});const file=path.join(root,"credential-journal.json");await writeFile(file,JSON.stringify({version:"noopolis.daimon.broker-credential-journal.v1",...value}),{mode:0o600});await chmod(file,0o600);}

test("credential authority promotes a fake CLI rotation and resumes promoted journal",async()=>{const home=await fixture();try{const command=await rotatingGrok(home,"rotated");const authority=new DurableGrokBrokerCredentialAuthority(command,home);await authority.initialize();const fresh=await authority.refreshAfterRejection(createHash("sha256").update("k".repeat(40)).digest("hex"));assert.equal(fresh,tokenFor("rotated"));const promoted=JSON.parse(await readFile(path.join(home,".daimon-broker","credential-journal.json"),"utf8")) as Record<string,unknown>;assert.equal(promoted.state,"promoted");const resumed=new DurableGrokBrokerCredentialAuthority(command,home);await resumed.initialize();assert.equal(await resumed.accessToken(false),tokenFor("rotated"));}finally{await rm(home,{recursive:true,force:true});}});

test("credential authority treats an unchanged successful CLI refresh as stale",async()=>{const home=await fixture();try{const command=await noopGrok(home);const authority=new DurableGrokBrokerCredentialAuthority(command,home);await authority.initialize();await assert.rejects(authority.refreshAfterRejection(createHash("sha256").update("k".repeat(40)).digest("hex")),/unavailable/u);assert.equal(authority.isStale(),true);const observed=JSON.parse(await readFile(path.join(home,".daimon-broker","credential-journal.json"),"utf8")) as Record<string,unknown>;assert.equal(observed.state,"stale");}finally{await rm(home,{recursive:true,force:true});}});

test("concurrent rejections of the same broker bearer spend one fake CLI exchange",async()=>{const home=await fixture();try{const command=await rotatingGrok(home,"singleflight");const authority=new DurableGrokBrokerCredentialAuthority(command,home);await authority.initialize();const rejected=createHash("sha256").update("k".repeat(40)).digest("hex");const results=await Promise.all([authority.refreshAfterRejection(rejected),authority.refreshAfterRejection(rejected),authority.refreshAfterRejection(rejected)]);assert.deepEqual(results,[tokenFor("singleflight"),tokenFor("singleflight"),tokenFor("singleflight")]);assert.equal(Number(await readFile(path.join(home,"refresh-count"),"utf8")),1);}finally{await rm(home,{recursive:true,force:true});}});

function tokenFor(label:string):string{return label.repeat(Math.ceil(40/label.length)).slice(0,40);}

async function rotatingGrok(home:string,label:string):Promise<string>{const command=path.join(home,`grok-${label}.cjs`);const token=tokenFor(label);await writeFile(command,`#!/usr/bin/env node
const fs=require("node:fs"),path=require("node:path"),home=process.env.GROK_HOME;
if(process.argv[2]!=="models")process.exit(9);
const count=path.join(home,"refresh-count");
const previous=Number(fs.existsSync(count)?fs.readFileSync(count,"utf8"):"0");
fs.writeFileSync(count,String(previous+1));
const authFile=path.join(home,"auth.json"),auth=JSON.parse(fs.readFileSync(authFile,"utf8"));
Object.values(auth)[0].key=previous===0?${JSON.stringify(token)}:String(previous).repeat(40);
fs.writeFileSync(authFile,JSON.stringify(auth));
`,{mode:0o700});await chmod(command,0o700);return command;}
async function noopGrok(home:string):Promise<string>{const command=path.join(home,"grok-noop.cjs");await writeFile(command,`#!/usr/bin/env node
if(process.argv[2]!=="models")process.exit(9);
`,{mode:0o700});await chmod(command,0o700);return command;}

test("retains multiple rotations across restart and a pre-exchange crash", async () => {
  const home = await fixture();
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const authFile = path.join(home, "auth.json"), journalFile = path.join(home, ".daimon-broker", "credential-journal.json");
  try {
    const original = digest(await readFile(authFile));
    const first = new DurableGrokBrokerCredentialAuthority(await rotatingGrok(home, "first"), home);
    await first.accessToken(true);
    const intermediate = digest(await readFile(authFile));
    const second = new DurableGrokBrokerCredentialAuthority(await rotatingGrok(home, "second"), home);
    await second.accessToken(true);
    const promoted = JSON.parse(await readFile(journalFile, "utf8"));
    assert.equal(promoted.generation, 2);
    assert.equal(promoted.sourceDigest, intermediate);
    assert.deepEqual(promoted.ancestorDigests, [original, intermediate]);
    const current = digest(await readFile(authFile));
    // Simulate death after persisting refreshing but before the CLI exchanges.
    await writeFile(journalFile, JSON.stringify({ ...promoted, state: "refreshing", sourceDigest: current, promotedDigest: undefined }));
    const third = new DurableGrokBrokerCredentialAuthority(await rotatingGrok(home, "third"), home);
    const beforeRecovery = await readFile(authFile);
    await third.accessToken(false);
    const settled = JSON.parse(await readFile(journalFile, "utf8"));
    assert.equal(settled.state, "promoted");
    assert.equal(settled.generation, 2);
    assert.equal(settled.sourceDigest, current);
    assert.equal(settled.promotedDigest, current);
    assert.deepEqual(settled.ancestorDigests, [original, intermediate]);
    assert.deepEqual(await readFile(authFile), beforeRecovery);
    assert.equal(Number(await readFile(path.join(home, "refresh-count"), "utf8")), 2);
    // A second restart needs no exchange and retains the durable settlement.
    const restarted = new DurableGrokBrokerCredentialAuthority("/nonexistent/grok", home);
    assert.equal(await restarted.accessToken(false), await third.accessToken(false));
    assert.deepEqual(JSON.parse(await readFile(journalFile, "utf8")), settled);
    await third.accessToken(true);
    const resumed = JSON.parse(await readFile(journalFile, "utf8"));
    assert.equal(resumed.generation, 3);
    assert.deepEqual(resumed.ancestorDigests, [original, intermediate, current]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("settles an interrupted first refresh without inventing a generation", async () => {
  const home = await fixture();
  try {
    const digest = createHash("sha256").update(await readFile(path.join(home, "auth.json"))).digest("hex");
    await journal(home, { state: "refreshing", generation: 0, sourceDigest: digest });
    const authority = new DurableGrokBrokerCredentialAuthority("/nonexistent/grok", home);
    await authority.accessToken(false);
    const settled = JSON.parse(await readFile(path.join(home, ".daimon-broker", "credential-journal.json"), "utf8"));
    assert.equal(settled.state, "promoted");
    assert.equal(settled.generation, 0);
    assert.equal(settled.promotedDigest, digest);
    assert.deepEqual(settled.ancestorDigests, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("recovery withholds readiness until settlement succeeds, including an ENOENT write failure", async (t) => {
  const home = await fixture();
  try {
    const digest = createHash("sha256").update(await readFile(path.join(home, "auth.json"))).digest("hex");
    await journal(home, { state: "refreshing", generation: 3, sourceDigest: digest });
    const authority = new DurableGrokBrokerCredentialAuthority("/nonexistent/grok", home);
    // Hold the persistence boundary, then fail it as a directory disappearing mid-write.
    const writer = authority as unknown as { write: (...args: unknown[]) => Promise<void> };
    let enter!: () => void, fail!: (error: Error) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const persisted = new Promise<void>((_resolve, reject) => { fail = reject; });
    const mocked = t.mock.method(writer, "write", async () => { enter(); await persisted; });
    let returned = false;
    const read = authority.accessToken(false).then((token) => { returned = true; return token; });
    const rejected = assert.rejects(read, /unavailable/u);
    await entered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(returned, false);
    fail(Object.assign(Error("synthetic persistence failure"), { code: "ENOENT" }));
    await rejected;
    mocked.mock.restore();
    // Retrying the same instance must perform the real durable write.
    await authority.accessToken(false);
    assert.equal(JSON.parse(await readFile(path.join(home, ".daimon-broker", "credential-journal.json"), "utf8")).state, "promoted");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("retains two same-expiry rotations in one running authority", async () => {
  const home = await fixture();
  try {
    const authFile = path.join(home, "auth.json");
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const original = digest(await readFile(authFile));
    const authority = new DurableGrokBrokerCredentialAuthority(await rotatingGrok(home, "twice"), home);
    await authority.accessToken(true);
    const intermediate = digest(await readFile(authFile));
    await authority.accessToken(true);
    const row = JSON.parse(await readFile(path.join(home, ".daimon-broker", "credential-journal.json"), "utf8"));
    assert.equal(row.generation, 2);
    assert.deepEqual(row.ancestorDigests, [original, intermediate]);
    assert.equal(row.promotedDigest, digest(await readFile(authFile)));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("expiry advancement compacts lineage; capacity refuses before spending a refresh", async () => {
  const home = await fixture();
  try {
    const authFile = path.join(home, "auth.json"), journalFile = path.join(home, ".daimon-broker", "credential-journal.json");
    const before = { "https://auth.x.ai::fixture": { key: "k".repeat(40), refresh_token: "r".repeat(20), expires_at: "2030-01-01T00:00:00Z" } };
    await writeFile(authFile, JSON.stringify(before));
    const digest = createHash("sha256").update(JSON.stringify(before)).digest("hex");
    const ancestorDigests = Array.from({ length: 900 }, (_, i) => createHash("sha256").update(`synthetic-${i}`).digest("hex"));
    await journal(home, { state: "promoted", generation: 900, sourceDigest: ancestorDigests[899], promotedDigest: digest, ancestorDigests });
    const command = await rotatingGrok(home, "capacity");
    const full = new DurableGrokBrokerCredentialAuthority(command, home);
    await assert.rejects(full.accessToken(true), /unavailable/u);
    await assert.rejects(readFile(path.join(home, "refresh-count")), { code: "ENOENT" });
    assert.equal((await readFile(authFile, "utf8")), JSON.stringify(before));
    const saved = JSON.parse(await readFile(journalFile, "utf8"));
    await writeFile(journalFile, JSON.stringify({ ...saved, ancestorDigests: ancestorDigests.slice(0, 898) }));
    const after = JSON.stringify({ "https://auth.x.ai::fixture": { ...before["https://auth.x.ai::fixture"], key: "n".repeat(40), expires_at: "2030-01-02T00:00:00Z" } });
    await writeFile(command, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(require("node:path").join(process.env.GROK_HOME,"auth.json"), ${JSON.stringify(after)});\n`, { mode: 0o700 });
    const advancing = new DurableGrokBrokerCredentialAuthority(command, home);
    await advancing.accessToken(true);
    assert.deepEqual(JSON.parse(await readFile(journalFile, "utf8")).ancestorDigests, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});
