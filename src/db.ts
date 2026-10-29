// state/connectors.sqlite: the call log, approvals, pending OAuth sign-ins
// and local mode's one-time admin sign-in codes. node:sqlite on Node 26 (older Nodes cut text at a NUL).

import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const ARGS_LOG_LIMIT = 16 * 1024;
export const CALL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type Decision =
  | "allow"
  | "deny"
  | "approved"
  | "declined"
  | "expired";

// Decisions that came from an "ask" rule: the "sends" view.
export const ASK_DECISIONS: readonly Decision[] = ["approved", "declined", "expired"];

export type CallRecord = {
  id: number;
  ts: number;
  agent: string;
  tailscaleLogin: string | null;
  upstream: string | null;
  tool: string;
  argsJson: string | null;
  argsSha256: string | null;
  decision: Decision;
  approvalId: string | null;
  durationMs: number | null;
  ok: number | null;
  error: string | null;
  resultBytes: number | null;
};

export type NewCall = {
  ts?: number;
  agent: string;
  tailscaleLogin?: string | null;
  upstream?: string | null;
  tool: string;
  args?: unknown;
  decision: Decision;
  approvalId?: string | null;
  durationMs?: number | null;
  ok?: boolean | null;
  error?: string | null;
  resultBytes?: number | null;
};

export type ApprovalStatus = "pending" | "approved" | "declined" | "expired" | "ran";

export type ApprovalRecord = {
  id: string;
  agent: string;
  upstream: string;
  tool: string;
  upstreamTool: string;
  argsJson: string;
  status: ApprovalStatus;
  note: string | null;
  tailscaleLogin: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  ranAt: number | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  tailscaleLogin TEXT,
  upstream TEXT,
  tool TEXT NOT NULL,
  argsJson TEXT,
  argsSha256 TEXT,
  decision TEXT NOT NULL,
  approvalId TEXT,
  durationMs INTEGER,
  ok INTEGER,
  error TEXT,
  resultBytes INTEGER
);
CREATE INDEX IF NOT EXISTS calls_ts ON calls (ts);
CREATE INDEX IF NOT EXISTS calls_agent_ts ON calls (agent, ts);
CREATE INDEX IF NOT EXISTS calls_decision_ts ON calls (decision, ts);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  upstream TEXT NOT NULL,
  tool TEXT NOT NULL,
  upstreamTool TEXT NOT NULL,
  argsJson TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  tailscaleLogin TEXT,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  decidedAt INTEGER,
  ranAt INTEGER
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, expiresAt);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  upstream TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);

-- Local mode: one-time codes from connectors open, kept as SHA-256.
CREATE TABLE IF NOT EXISTS login_codes (
  codeSha256 TEXT PRIMARY KEY,
  expiresAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Keys whose values never go in the log, at any depth.
const SECRET_KEY = /pass(word|phrase)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key/i;

/** Replaces values under secret-looking keys with "[redacted]". */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[too deep]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    // No prototype, so a "__proto__" key from JSON stays an ordinary, visible
    // key instead of silently becoming the copy's prototype.
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** Cuts a string to at most `limit` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  const marker = ` [truncated ${bytes.length - limit} bytes]`;
  let cut = limit - Buffer.byteLength(marker);
  // Step back off a continuation byte so the cut lands on a character start.
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
  return bytes.subarray(0, cut).toString("utf8") + marker;
}

export function argsForLog(args: unknown): { argsJson: string; argsSha256: string } {
  const full = JSON.stringify(args ?? {});
  return {
    argsJson: truncateUtf8(JSON.stringify(redact(args ?? {})), ARGS_LOG_LIMIT),
    argsSha256: createHash("sha256").update(full).digest("hex"),
  };
}

export type CallFilter = {
  agent?: string;
  upstream?: string;
  decision?: string;
  sendsOnly?: boolean;
  limit?: number;
};

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  logCall(call: NewCall): number {
    const { argsJson, argsSha256 } =
      call.args === undefined ? { argsJson: null, argsSha256: null } : argsForLog(call.args);
    const result = this.db
      .prepare(
        `INSERT INTO calls (ts, agent, tailscaleLogin, upstream, tool, argsJson, argsSha256,
           decision, approvalId, durationMs, ok, error, resultBytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.ts ?? Date.now(),
        call.agent,
        call.tailscaleLogin ?? null,
        call.upstream ?? null,
        call.tool,
        argsJson,
        argsSha256,
        call.decision,
        call.approvalId ?? null,
        call.durationMs ?? null,
        call.ok === undefined || call.ok === null ? null : call.ok ? 1 : 0,
        call.error ? truncateUtf8(call.error, 2048) : null,
        call.resultBytes ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  calls(filter: CallFilter = {}): CallRecord[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.agent) {
      where.push("agent = ?");
      params.push(filter.agent);
    }
    if (filter.upstream) {
      where.push("upstream = ?");
      params.push(filter.upstream);
    }
    if (filter.decision) {
      where.push("decision = ?");
      params.push(filter.decision);
    }
    if (filter.sendsOnly) {
      where.push(`decision IN (${ASK_DECISIONS.map(() => "?").join(", ")})`);
      params.push(...ASK_DECISIONS);
    }
    const sql = `SELECT * FROM calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ts DESC, id DESC LIMIT ?`;
    params.push(filter.limit ?? 200);
    return this.db.prepare(sql).all(...params) as unknown as CallRecord[];
  }

  lastCallByAgent(): Map<string, number> {
    const rows = this.db
      .prepare("SELECT agent, MAX(ts) AS ts FROM calls GROUP BY agent")
      .all() as { agent: string; ts: number }[];
    return new Map(rows.map((row) => [row.agent, row.ts]));
  }

  distinctCallValues(column: "agent" | "upstream" | "decision"): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT ${column} AS value FROM calls WHERE ${column} IS NOT NULL ORDER BY 1`)
      .all() as { value: string }[];
    return rows.map((row) => row.value);
  }

  // Approvals

  insertApproval(record: ApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, agent, upstream, tool, upstreamTool, argsJson, status, note,
           tailscaleLogin, createdAt, expiresAt, decidedAt, ranAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.agent,
        record.upstream,
        record.tool,
        record.upstreamTool,
        record.argsJson,
        record.status,
        record.note,
        record.tailscaleLogin,
        record.createdAt,
        record.expiresAt,
        record.decidedAt,
        record.ranAt,
      );
  }

  getApproval(id: string): ApprovalRecord | undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | ApprovalRecord
      | undefined;
  }

  /**
   * Moves a pending, unexpired approval to approved or declined. An
   * approved call gets a new expiresAt: the time by which it has to run.
   */
  decideApproval(
    id: string,
    status: "approved" | "declined",
    note: string | null,
    now: number,
    runBy?: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = ?, note = ?, decidedAt = ?, expiresAt = COALESCE(?, expiresAt)
         WHERE id = ? AND status = 'pending' AND expiresAt > ?`,
      )
      .run(status, note, now, runBy ?? null, id, now);
    return result.changes === 1;
  }

  /** Claims an approved, unexpired call to run. True for exactly one caller. */
  claimApprovalRun(id: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = 'ran', ranAt = ?
         WHERE id = ? AND status = 'approved' AND expiresAt > ?`,
      )
      .run(now, id, now);
    return result.changes === 1;
  }

  /**
   * Swaps the full arguments for the redacted, truncated copy once an
   * approval no longer needs them to run.
   */
  scrubApprovalArgs(id: string, args: unknown): void {
    this.db
      .prepare("UPDATE approvals SET argsJson = ? WHERE id = ?")
      .run(argsForLog(args).argsJson, id);
  }

  /**
   * Marks pending approvals past their expiry, and approved calls nobody ran
   * in time, as expired, and returns them. An approved one keeps decidedAt
   * (when it was approved), so it can be told apart afterwards.
   */
  expireApprovals(now: number): ApprovalRecord[] {
    const due = this.db
      .prepare(`SELECT * FROM approvals WHERE status IN ('pending', 'approved') AND expiresAt <= ?`)
      .all(now) as unknown as ApprovalRecord[];
    const update = this.db.prepare(
      `UPDATE approvals SET status = 'expired',
         decidedAt = CASE WHEN status = 'pending' THEN ? ELSE decidedAt END
       WHERE id = ? AND status = ? AND expiresAt <= ?`,
    );
    return due
      .filter((record) => update.run(now, record.id, record.status, now).changes === 1)
      .map((record) => ({ ...record, status: "expired" as const, decidedAt: record.decidedAt ?? now }));
  }

  pendingApprovals(now: number): ApprovalRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM approvals WHERE status = 'pending' AND expiresAt > ? ORDER BY createdAt DESC`,
      )
      .all(now) as unknown as ApprovalRecord[];
  }

  // OAuth sign-in states: single use, bound to one upstream.

  insertOAuthState(state: string, upstream: string, now: number, ttlMs: number): void {
    this.db
      .prepare("INSERT INTO oauth_states (state, upstream, createdAt, expiresAt) VALUES (?, ?, ?, ?)")
      .run(state, upstream, now, now + ttlMs);
  }

  /** Deletes the state and returns its upstream if it was valid. */
  takeOAuthState(state: string, now: number): string | undefined {
    const row = this.db
      .prepare("DELETE FROM oauth_states WHERE state = ? RETURNING upstream, expiresAt")
      .get(state) as { upstream: string; expiresAt: number } | undefined;
    if (!row || row.expiresAt <= now) return undefined;
    return row.upstream;
  }

  // Local mode's admin sign-in codes: single use, stored as a hash.

  insertLoginCode(code: string, now: number, ttlMs: number): void {
    this.db.prepare("DELETE FROM login_codes WHERE expiresAt <= ?").run(now);
    this.db.prepare("INSERT INTO login_codes (codeSha256, expiresAt) VALUES (?, ?)").run(sha256(code), now + ttlMs);
  }

  /** Deletes the code and says whether it was valid. */
  takeLoginCode(code: string, now: number): boolean {
    const row = this.db
      .prepare("DELETE FROM login_codes WHERE codeSha256 = ? RETURNING expiresAt")
      .get(sha256(code)) as { expiresAt: number } | undefined;
    return Boolean(row && row.expiresAt > now);
  }

  // Pruning

  prune(now: number): { calls: number; approvals: number; states: number } {
    const cutoff = now - CALL_RETENTION_MS;
    const calls = this.db.prepare("DELETE FROM calls WHERE ts < ?").run(cutoff).changes;
    const approvals = this.db
      .prepare(`DELETE FROM approvals WHERE status != 'pending' AND createdAt < ?`)
      .run(cutoff).changes;
    const states = this.db.prepare("DELETE FROM oauth_states WHERE expiresAt <= ?").run(now).changes;
    this.db.prepare("DELETE FROM login_codes WHERE expiresAt <= ?").run(now);
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('lastPrune', ?)").run(String(now));
    return { calls: Number(calls), approvals: Number(approvals), states: Number(states) };
  }

  lastPrune(): number | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'lastPrune'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : undefined;
  }
}
