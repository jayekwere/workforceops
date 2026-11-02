import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { digest, Fault, requireRole, type Identity } from './security.js';
export interface Plan<T = Record<string, unknown>> {
  id: string;
  binding: {
    tenant: string;
    requestedBy: string;
    createdAt: string;
    expiresAt: string;
    policyHash: string;
    data: T;
  };
  digest: string;
  status: 'planned' | 'approved' | 'executing' | 'blocked' | 'uncertain' | 'completed' | 'rejected';
  reviewer?: string;
  executor?: string;
  executionKey?: string;
  lease?: string;
  updatedAt?: string;
  result?: unknown;
}
export class Approvals<T = Record<string, unknown>> {
  constructor(
    readonly store: Store,
    readonly policyHash: string,
  ) {}
  plan(actor: Identity, data: T, ttl = 900000): Plan<T> {
    requireRole(actor, 'requester');
    return this.store.tx(() => {
      if (this.store.count(actor.tenant, 'plan') >= 100)
        throw new Fault(409, 'plan_capacity_reached');
      const binding = {
        tenant: actor.tenant,
        requestedBy: actor.subject,
        createdAt: new Date(this.store.now()).toISOString(),
        expiresAt: new Date(this.store.now() + ttl).toISOString(),
        policyHash: this.policyHash,
        data,
      };
      const p: Plan<T> = { id: randomUUID(), binding, digest: digest(binding), status: 'planned' };
      this.store.put(actor.tenant, 'plan', p.id, p);
      this.store.audit(actor, 'plan.created', 'planned', { id: p.id, digest: p.digest });
      return p;
    });
  }
  get(actor: Identity, id: string): Plan<T> {
    const p = this.store.need<Plan<T>>(actor.tenant, 'plan', id);
    if (p.binding.tenant !== actor.tenant || digest(p.binding) !== p.digest)
      throw new Fault(409, 'plan_integrity_failed');
    return p;
  }
  validate(p: Plan<T>) {
    if (
      p.binding.policyHash !== this.policyHash ||
      Date.parse(p.binding.expiresAt) <= this.store.now()
    )
      throw new Fault(409, 'plan_expired_or_policy_changed');
  }
  review(actor: Identity, id: string, hashed: string, approve: boolean) {
    requireRole(actor, 'reviewer');
    return this.store.tx(() => {
      const p = this.get(actor, id);
      this.validate(p);
      if (p.binding.requestedBy === actor.subject)
        throw new Fault(403, 'independent_reviewer_required');
      if (p.status !== 'planned' || p.digest !== hashed)
        throw new Fault(409, 'plan_state_or_digest_changed');
      p.status = approve ? 'approved' : 'rejected';
      p.reviewer = actor.subject;
      this.store.put(actor.tenant, 'plan', id, p);
      this.store.audit(actor, 'plan.reviewed', p.status, { id, digest: hashed });
      return p;
    });
  }
  claim(
    actor: Identity,
    id: string,
    hashed: string,
    key: string,
  ): { plan: Plan<T>; claimed: boolean } {
    requireRole(actor, 'operator');
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(key)) throw new Fault(400, 'invalid_idempotency_key');
    return this.store.tx(() => {
      const p = this.get(actor, id),
        binding = digest({ id, hashed, actor: actor.subject });
      const old = this.store.get<{ binding: string }>(actor.tenant, 'idempotency', key);
      if (old && old.binding !== binding) throw new Fault(409, 'idempotency_conflict');
      if (p.binding.requestedBy === actor.subject || p.reviewer === actor.subject)
        throw new Fault(403, 'independent_operator_required');
      if (p.digest !== hashed) throw new Fault(409, 'plan_state_or_digest_changed');
      if (old && p.executionKey === key && !['approved', 'blocked'].includes(p.status))
        return { plan: p, claimed: false };
      this.validate(p);
      if (!['approved', 'blocked'].includes(p.status) || (p.executionKey && p.executionKey !== key))
        throw new Fault(409, 'plan_not_executable');
      if (!old && this.store.count(actor.tenant, 'idempotency') >= 1000)
        throw new Fault(409, 'idempotency_capacity_reached');
      this.store.put(actor.tenant, 'idempotency', key, { binding });
      p.status = 'executing';
      p.lease = randomUUID();
      p.updatedAt = new Date(this.store.now()).toISOString();
      p.executor = actor.subject;
      p.executionKey = key;
      this.store.put(actor.tenant, 'plan', id, p);
      this.store.audit(actor, 'plan.claimed', 'executing', { id, digest: hashed });
      return { plan: p, claimed: true };
    });
  }
  assertLease(actor: Identity, p: Plan<T>) {
    const current = this.get(actor, p.id);
    if (!p.lease || current.lease !== p.lease || current.status !== 'executing')
      throw new Fault(409, 'execution_lease_changed');
  }
  fence(actor: Identity, p: Plan<T>) {
    requireRole(actor, 'operator');
    return this.store.tx(() => {
      const current = this.get(actor, p.id);
      if (current.lease !== p.lease || current.status !== p.status)
        throw new Fault(409, 'execution_lease_changed');
      p.lease = randomUUID();
      p.updatedAt = new Date(this.store.now()).toISOString();
      this.store.put(actor.tenant, 'plan', p.id, p);
      return p;
    });
  }
  save(actor: Identity, p: Plan<T>, status: Plan<T>['status'], result?: unknown) {
    return this.store.tx(() => {
      const current = this.get(actor, p.id);
      if (p.lease && current.lease !== p.lease) throw new Fault(409, 'execution_lease_changed');
      p.updatedAt = new Date(this.store.now()).toISOString();
      p.status = status;
      if (result !== undefined) p.result = result;
      this.store.put(actor.tenant, 'plan', p.id, p);
      this.store.audit(actor, 'plan.' + status, status, { id: p.id, digest: p.digest });
      return p;
    });
  }
  list(actor: Identity) {
    requireRole(actor, 'viewer', 'requester', 'reviewer', 'operator');
    return this.store.list<Plan<T>>(actor.tenant, 'plan');
  }
}
