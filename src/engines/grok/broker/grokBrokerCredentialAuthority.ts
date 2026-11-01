import { ENGINE_DESCRIPTORS } from "../../descriptors.js";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { readGrokBrokerCredential } from "./grokBrokerCredentialReader.js";
import { refreshGrokBrokerCredential } from "../../../gateway/grokRefresh.js";
import { EngineBrokerGenerationFence, EngineBrokerSingleflight } from "./engineBrokerSingleflight.js";
import { BROKER_CREDENTIAL_MAX_ANCESTORS, parseBrokerCredentialJournal, recoverBrokerCredentialJournal } from "./engineBrokerCredentialJournal.js";

export class DurableGrokBrokerCredentialAuthority {
  private readonly flight = new EngineBrokerSingleflight<string>(); private readonly fence = new EngineBrokerGenerationFence(); private stale = false;private initialized=false;private staleWrite:Promise<void>|undefined;private lastDigest:string|undefined;private generation=0;
  private ancestorDigests: readonly string[] = [];
  constructor(private readonly command: string, private readonly home: string, private readonly authFile = path.join(home, ENGINE_DESCRIPTORS.grok.auth.fileName)) {}
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const credential = await readGrokBrokerCredential(this.authFile);
    this.lastDigest = credential.digest;
    const file = path.join(this.home, ".daimon-broker", "credential-journal.json");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536) throw unavailable();
      const journal = parseBrokerCredentialJournal(JSON.parse(await handle.readFile("utf8")));
      this.generation = journal.generation;
      if (recoverBrokerCredentialJournal(journal, credential.digest) === "stale") {
        await this.markStale();
        throw unavailable();
      }
      this.ancestorDigests = [...new Set([...(journal.ancestorDigests ?? []), journal.sourceDigest])]
        .filter((digest) => digest !== credential.digest);
      if (journal.state === "refreshing") {
        // The durable credential still matches the pre-exchange source. Settle
        // before serving it so writeback and drain need no subsequent refresh.
        // No exchange completed: preserve the generation and existing lineage.
        await this.write({ state: "promoted", generation: journal.generation,
          sourceDigest: credential.digest, promotedDigest: credential.digest });
      }
      this.fence.restore(journal.generation);
    } catch (error) {
      // Only a missing journal on open is an unjournaled bootstrap. A failed
      // recovery write (including ENOENT) must never publish readiness.
      if (handle !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
    } finally { await handle?.close().catch(() => undefined); }
    this.initialized = true;
  }
  async accessToken(forceRefresh: boolean): Promise<string> {
    if(!this.initialized)await this.initialize();if (this.stale) throw unavailable(); if (!forceRefresh) return (await readGrokBrokerCredential(this.authFile)).accessToken;
    return this.refresh();
  }
  async refreshAfterRejection(rejectedTokenDigest:string):Promise<string>{if(!/^[a-f0-9]{64}$/u.test(rejectedTokenDigest))throw unavailable();return this.refresh(rejectedTokenDigest);}
  private refresh(rejectedTokenDigest?:string):Promise<string>{return this.flight.run(async () => {
      if (this.stale) throw unavailable(); const generation = this.fence.snapshot(); const before = await readGrokBrokerCredential(this.authFile);if(rejectedTokenDigest!==undefined&&createHash("sha256").update(before.accessToken).digest("hex")!==rejectedTokenDigest)return before.accessToken;
      // Never spend a refresh whose lineage cannot be persisted. Advancing expiry
      // normally clears the history, so this bound applies to one expiry epoch.
      const ancestors = [...new Set([...this.ancestorDigests, before.digest])];
      if (ancestors.length > BROKER_CREDENTIAL_MAX_ANCESTORS) throw unavailable();
      try {
        await this.write({ state: "refreshing", generation, sourceDigest: before.digest }); await refreshGrokBrokerCredential(this.command, this.home); const after = await readGrokBrokerCredential(this.authFile);
        if (after.digest === before.digest) throw unavailable(); const next = this.fence.promote(generation);this.generation=next; const ancestorDigests = before.expiresAt !== undefined && after.expiresAt !== undefined && after.expiresAt > before.expiresAt ? [] : ancestors;
        await this.write({ state: "promoted", generation: next, sourceDigest: before.digest, promotedDigest: after.digest, ancestorDigests });this.ancestorDigests=ancestorDigests;this.lastDigest=after.digest; return after.accessToken;
      } catch { await this.markStale(); throw unavailable(); }
    });}
  async markRejected(rejectedTokenDigest?:string): Promise<void> { if(rejectedTokenDigest!==undefined){if(!/^[a-f0-9]{64}$/u.test(rejectedTokenDigest))throw unavailable();const current=await readGrokBrokerCredential(this.authFile);if(createHash("sha256").update(current.accessToken).digest("hex")!==rejectedTokenDigest)throw unavailable();}if (!this.stale) await this.markStale();throw unavailable(); }
  isStale():boolean{return this.stale;}
  private markStale():Promise<void>{if(this.staleWrite)return this.staleWrite;this.stale=true;this.fence.markStale();return this.staleWrite=(async()=>{const rejected=this.lastDigest??(await readGrokBrokerCredential(this.authFile)).digest;await this.write({state:"stale",generation:this.generation,sourceDigest:rejected,promotedDigest:rejected});})();}
  private async write(value: { state: "refreshing" | "promoted" | "stale"; generation: number; sourceDigest: string; promotedDigest?: string; ancestorDigests?: readonly string[] }): Promise<void> {
    const root = path.join(this.home, ".daimon-broker"); await mkdir(root, { recursive: true, mode: 0o700 }); const file = path.join(root, "credential-journal.json"); const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); try { await handle.writeFile(`${JSON.stringify({ version: "noopolis.daimon.broker-credential-journal.v1", ancestorDigests: this.ancestorDigests, ...value })}\n`); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, file); const directory = await open(root, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } } finally { await unlink(temporary).catch(() => undefined); }
  }
}
const unavailable = (): Error => new Error("Grok broker credential authority unavailable");
