/**
 * The operator-facing record of a wake HELD by an exhausted budget.
 *
 * On 2026-10-21 a per-agent attention budget ran out mid-morning and Daimon
 * then accepted and held every later wake without a single line anywhere; the
 * edition shipped hours late because nobody knew. A budget pause is correct
 * behaviour, a SILENT one is not. So every hold now produces one stderr line
 * (the `daimon: …` surface the host's alert job already reads from container
 * logs) and one row in the fuse ledger, and so does the moment it clears.
 *
 * It is a state machine, not a rate limiter: a line is written on a
 * transition — none → parked(reason, epoch), parked → parked under another
 * reason or epoch, parked → cleared — and never for a repeat of the same state.
 * Re-polling a parked agent every second therefore writes nothing. The ledger
 * rows are replayed at open so a restart does not re-announce a park the
 * operator has already been told about.
 */
export type WakeParkReason = "attention_tokens" | "attention_executions" | "org_tokens" | "org_wakes";
export type WakeParkRow = Readonly<{ kind: "park"; epoch: string; at: string; agent: string; reason: WakeParkReason; used: number; limit: number }>
  | Readonly<{ kind: "unpark"; epoch: string; at: string; agent: string; reason: WakeParkReason }>;

type Parked = Readonly<{ reason: WakeParkReason; epoch: string }>;

export class WakeParkLog {
  private readonly parked = new Map<string, Parked>();

  constructor(private readonly persist: (row: WakeParkRow) => Promise<void>, private readonly now: () => Date) {}

  /** Replays ledger rows (oldest first) so a restarted host keeps its parked set. */
  seed(rows: readonly WakeParkRow[]): void {
    for (const row of rows) {
      if (row.kind === "park") this.parked.set(row.agent, { reason: row.reason, epoch: row.epoch });
      else this.parked.delete(row.agent);
    }
  }

  async park(agent: string, reason: WakeParkReason, used: number, limit: number, epoch: string): Promise<void> {
    const current = this.parked.get(agent);
    if (current?.reason === reason && current.epoch === epoch) return;
    this.parked.set(agent, { reason, epoch });
    console.error(`daimon: wake parked agent=${agent} reason=${reason} used=${used} limit=${limit} epoch=${epoch}`);
    await this.record({ kind: "park", epoch, at: this.now().toISOString(), agent, reason, used, limit });
  }

  async clear(agent: string, epoch: string): Promise<void> {
    const current = this.parked.get(agent);
    if (current === undefined) return;
    this.parked.delete(agent);
    console.error(`daimon: wake unparked agent=${agent} reason=${current.reason} epoch=${epoch}`);
    await this.record({ kind: "unpark", epoch, at: this.now().toISOString(), agent, reason: current.reason });
  }

  agents(): string[] { return [...this.parked.keys()]; }

  /** Advisory: the stderr line is already out, and a ledger fault must never change a verdict. */
  private async record(row: WakeParkRow): Promise<void> {
    try { await this.persist(row); } catch { /* the fuse's own admission path owns ledger failure */ }
  }
}

/** Which counter held the wake, and its used/limit pair, from a fuse measurement. */
export function parkOf(measured: Readonly<{ reason: string | undefined; used: number; tokens: number; agentUsed: number; agentTokens: number; maxWakes: number; maxTokens: number; limits: Readonly<{ maxExecutions?: number; maxTokens?: number }> }>): Readonly<{ reason: WakeParkReason; used: number; limit: number }> | undefined {
  switch (measured.reason) {
    case "agent_token_ceiling": return { reason: "attention_tokens", used: measured.agentTokens, limit: measured.limits.maxTokens ?? 0 };
    case "agent_execution_ceiling": return { reason: "attention_executions", used: measured.agentUsed, limit: measured.limits.maxExecutions ?? 0 };
    case "token_ceiling": return { reason: "org_tokens", used: measured.tokens, limit: measured.maxTokens };
    case "wake_ceiling": return { reason: "org_wakes", used: measured.used, limit: measured.maxWakes };
    default: return undefined;
  }
}

export function isWakeParkRow(value: Record<string, unknown>): boolean {
  const reasons: readonly unknown[] = ["attention_tokens", "attention_executions", "org_tokens", "org_wakes"];
  if ((value.kind !== "park" && value.kind !== "unpark") || typeof value.agent !== "string" || !reasons.includes(value.reason)) return false;
  return value.kind === "unpark" || typeof value.used === "number" && typeof value.limit === "number";
}
