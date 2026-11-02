import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, mac, equal, Fault, type Identity } from './security.js';
export interface Audit {
  seq: number;
  at: string;
  tenant: string;
  actor: string;
  action: string;
  outcome: string;
  detail: Record<string, unknown>;
  previous: string;
  hash: string;
}
export class Store {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(
    file: string,
    private key: string,
    readonly now = () => Date.now(),
  ) {
    if (Buffer.byteLength(key) < 32) throw new Error('Audit key requires 32 bytes');
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(tenant TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(tenant,kind,id)); CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,body TEXT NOT NULL,hash TEXT NOT NULL); CREATE INDEX IF NOT EXISTS audit_tenant ON audit(json_extract(body,'$.tenant')); CREATE INDEX IF NOT EXISTS audit_actor_action ON audit(json_extract(body,'$.tenant'),json_extract(body,'$.action'),json_extract(body,'$.actor'));`,
    );
    if (!this.verify()) {
      this.db.close();
      throw new Error('Audit integrity failure');
    }
  }
  tx<T>(fn: () => T): T {
    const n = this.depth;
    this.db.exec(n ? `SAVEPOINT nested_${n}` : 'BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec(n ? `RELEASE nested_${n}` : 'COMMIT');
      return result;
    } catch (e) {
      this.db.exec(n ? `ROLLBACK TO nested_${n}` : 'ROLLBACK');
      if (n) this.db.exec(`RELEASE nested_${n}`);
      throw e;
    } finally {
      this.depth--;
    }
  }
  get<T>(tenant: string, kind: string, id: string): T | undefined {
    const row = this.db
      .prepare('SELECT body FROM records WHERE tenant=? AND kind=? AND id=?')
      .get(tenant, kind, id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : undefined;
  }
  need<T>(tenant: string, kind: string, id: string): T {
    const value = this.get<T>(tenant, kind, id);
    if (!value) throw new Fault(404, 'record_not_found');
    return value;
  }
  put(tenant: string, kind: string, id: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(tenant,kind,id) DO UPDATE SET body=excluded.body',
      )
      .run(tenant, kind, id, canonical(value));
  }
  list<T>(tenant: string, kind: string, limit = 200): T[] {
    return (
      this.db
        .prepare('SELECT body FROM records WHERE tenant=? AND kind=? ORDER BY rowid DESC LIMIT ?')
        .all(tenant, kind, limit) as { body: string }[]
    ).map((r) => JSON.parse(r.body) as T);
  }
  remove(tenant: string, kind: string, id: string) {
    return this.db
      .prepare('DELETE FROM records WHERE tenant=? AND kind=? AND id=?')
      .run(tenant, kind, id).changes;
  }
  count(tenant: string, kind: string) {
    return (
      this.db
        .prepare('SELECT count(*) AS n FROM records WHERE tenant=? AND kind=?')
        .get(tenant, kind) as { n: number }
    ).n;
  }
  auditCount(tenant: string, action?: string, actor?: string, source?: string): number {
    const clauses = ["json_extract(body,'$.tenant')= ?"];
    const values: string[] = [tenant];
    for (const [field, value] of [
      ['action', action],
      ['actor', actor],
      ['detail.source', source],
    ] as const)
      if (value !== undefined) {
        clauses.push(`json_extract(body,'$.${field}')= ?`);
        values.push(value);
      }
    return (
      this.db
        .prepare('SELECT count(*) AS n FROM audit WHERE ' + clauses.join(' AND '))
        .get(...values) as { n: number }
    ).n;
  }
  audit(
    actor: Identity,
    action: string,
    outcome: string,
    detail: Record<string, unknown> = {},
  ): Audit {
    const row = this.db.prepare('SELECT seq,hash FROM audit ORDER BY seq DESC LIMIT 1').get() as
      { seq: number; hash: string } | undefined;
    if ((row?.seq ?? 0) >= 100000) throw new Fault(507, 'audit_capacity_reached');
    if (this.auditCount(actor.tenant) >= 10000)
      throw new Fault(507, 'tenant_audit_capacity_reached');
    const body = {
      seq: (row?.seq ?? 0) + 1,
      at: new Date(this.now()).toISOString(),
      tenant: actor.tenant,
      actor: actor.subject,
      action,
      outcome,
      detail,
      previous: row?.hash ?? 'genesis',
    };
    const hash = mac(this.key, body);
    this.db.prepare('INSERT INTO audit VALUES(?,?,?)').run(body.seq, canonical(body), hash);
    return { ...body, hash };
  }
  audits(tenant: string, limit = 200): Audit[] {
    return (
      this.db
        .prepare(
          "SELECT body,hash FROM audit WHERE json_extract(body,'$.tenant')=? ORDER BY seq DESC LIMIT ?",
        )
        .all(tenant, limit) as { body: string; hash: string }[]
    ).map((r) => ({ ...JSON.parse(r.body), hash: r.hash }));
  }
  verify() {
    let prior = 'genesis',
      seq = 1;
    for (const r of this.db.prepare('SELECT body,hash FROM audit ORDER BY seq').all() as {
      body: string;
      hash: string;
    }[]) {
      try {
        const v = JSON.parse(r.body) as Audit;
        if (v.seq !== seq++ || v.previous !== prior || !equal(mac(this.key, v), r.hash))
          return false;
        prior = r.hash;
      } catch {
        return false;
      }
    }
    return true;
  }
  sign(v: unknown) {
    return mac(this.key, { purpose: 'configuration-backup-v1', payload: v });
  }
  check(v: unknown, signature: string) {
    return equal(this.sign(v), signature);
  }
  close() {
    this.db.close();
  }
}
