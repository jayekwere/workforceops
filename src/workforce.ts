import { z } from 'zod';
import { Approvals, type Plan } from './approvals.js';
import { Store } from './store.js';
import { Id, Text, digest, Fault, requireRole, type Identity } from './security.js';
import { ScimClient, project, type Desired, type ScimUser } from './scim.js';
export const EmployeeSchema = z
  .object({
    id: Id,
    tenant: Id,
    name: Text,
    email: z.email().max(160),
    department: z.enum(['engineering', 'operations']),
    employment: z.enum(['active', 'departed']),
  })
  .strict();
export type Employee = z.infer<typeof EmployeeSchema>;
export const policies = {
  version: '1.0.0',
  roles: { engineering: ['reader', 'developer'], operations: ['reader', 'support'] },
};
export const PlanInput = z
  .object({
    employeeId: Id,
    action: z.enum(['onboard', 'change-role', 'offboard']),
    department: z.enum(['engineering', 'operations']).optional(),
  })
  .strict();
interface Step {
  provider: string;
  providerHash: string;
  before: ScimUser | null;
  desired: Desired;
}
export interface LifecycleData {
  employee: Employee;
  employeeHash: string;
  action: z.infer<typeof PlanInput>['action'];
  department: Employee['department'];
  steps: Step[];
  tasks: string[];
}
export interface StepResult {
  provider: string;
  status: 'pending' | 'dispatching' | 'verified' | 'blocked' | 'uncertain';
  evidence?: { before: string; after: string; observedAt: string };
  reason?: string;
}
export class Workforce {
  readonly book: Approvals<LifecycleData>;
  constructor(
    readonly store: Store,
    readonly providers: ScimClient[],
  ) {
    if (
      new Set(providers.map((p) => p.config.tenant + ':' + p.config.alias)).size !==
        providers.length ||
      new Set(providers.map((p) => p.base.href.replace(/\/$/, ''))).size !== providers.length
    )
      throw new Error('Duplicate provider authority');
    this.book = new Approvals(store, digest(policies));
  }
  employees(actor: Identity) {
    requireRole(actor, 'viewer', 'requester', 'reviewer', 'operator');
    return this.store.list<Employee>(actor.tenant, 'employee');
  }
  async plan(actor: Identity, input: unknown) {
    requireRole(actor, 'requester');
    const request = PlanInput.parse(input);
    const employee = this.store.need<Employee>(actor.tenant, 'employee', request.employeeId);
    if (request.action !== 'offboard' && employee.employment !== 'active')
      throw new Fault(409, 'employee_not_active');
    const department = request.department ?? employee.department;
    const desired: Desired = {
      externalId: employee.id,
      userName: employee.email,
      displayName: employee.name,
      active: request.action !== 'offboard',
      roles: request.action === 'offboard' ? [] : [...policies.roles[department]].sort(),
    };
    const steps: Step[] = [];
    for (const provider of this.providers.filter((p) => p.config.tenant === actor.tenant)) {
      const before = await provider.find(employee.id);
      if (before && before.userName !== employee.email)
        throw new Fault(409, 'managed_identity_changed');
      if (request.action === 'change-role' && !before) throw new Fault(409, 'onboarding_required');
      if (request.action === 'offboard' && !before) continue;
      steps.push({
        provider: provider.config.alias,
        providerHash: provider.fingerprint,
        before,
        desired,
      });
    }
    if (!steps.length) throw new Fault(409, 'no_managed_accounts');
    return this.book.plan(actor, {
      employee,
      employeeHash: digest(employee),
      action: request.action,
      department,
      steps,
      tasks:
        request.action === 'offboard'
          ? ['Confirm data-retention decision', 'Confirm equipment-return decision']
          : [],
    });
  }
  private ensure(p: Plan<LifecycleData>) {
    this.book.validate(p);
    const employee = this.store.need<Employee>(
      p.binding.tenant,
      'employee',
      p.binding.data.employee.id,
    );
    if (digest(employee) !== p.binding.data.employeeHash) throw new Fault(409, 'employee_changed');
    for (const step of p.binding.data.steps) {
      const provider = this.providers.find(
        (x) => x.config.alias === step.provider && x.config.tenant === p.binding.tenant,
      );
      if (!provider || provider.fingerprint !== step.providerHash)
        throw new Fault(409, 'provider_configuration_changed');
    }
  }
  async execute(actor: Identity, id: string, hashed: string, key: string) {
    const found = this.book.get(actor, id);
    if (!['completed', 'executing', 'uncertain'].includes(found.status)) this.ensure(found);
    const claim = this.store.tx(() => {
      const locked = this.store.get<{ plan: string }>(
        actor.tenant,
        'employee-lock',
        found.binding.data.employee.id,
      );
      if (locked && locked.plan !== id && found.status !== 'completed')
        throw new Fault(409, 'employee_has_unresolved_operation');
      const claim = this.book.claim(actor, id, hashed, key);
      if (claim.claimed)
        this.store.put(actor.tenant, 'employee-lock', found.binding.data.employee.id, { plan: id });
      return claim;
    });
    if (!claim.claimed) return claim.plan;
    let p = claim.plan;
    const outcomes: StepResult[] =
      (p.result as { steps: StepResult[] } | undefined)?.steps ??
      p.binding.data.steps.map((s) => ({ provider: s.provider, status: 'pending' as const }));
    p = this.book.save(actor, p, 'executing', { steps: outcomes });
    for (let index = 0; index < p.binding.data.steps.length; index++) {
      const step = p.binding.data.steps[index]!,
        outcome = outcomes[index]!;
      if (outcome.status === 'verified') continue;
      if (['dispatching', 'uncertain'].includes(outcome.status)) {
        p = this.book.save(actor, p, 'uncertain', { steps: outcomes });
        return p;
      }
      const provider = this.providers.find(
        (x) => x.config.alias === step.provider && x.config.tenant === actor.tenant,
      )!;
      let before: ScimUser | null;
      try {
        before = await provider.find(step.desired.externalId);
      } catch {
        outcome.status = 'blocked';
        outcome.reason = 'provider_read_unavailable';
        return this.book.save(actor, p, 'blocked', { steps: outcomes });
      }
      const expected = digest(step.before);
      if (digest(before) !== expected) {
        outcome.status = 'blocked';
        outcome.reason = 'account_changed_since_approval';
        return this.book.save(actor, p, 'blocked', { steps: outcomes });
      }
      if (before && digest(project(before)) === digest(step.desired)) {
        outcome.status = 'verified';
        outcome.evidence = {
          before: digest(before),
          after: digest(before),
          observedAt: new Date(this.store.now()).toISOString(),
        };
        p = this.book.save(actor, p, 'executing', { steps: outcomes });
        continue;
      }
      // Recheck expiry and configuration after network reads, before committing dispatch intent.
      try {
        this.ensure(p);
      } catch {
        outcome.status = 'blocked';
        outcome.reason = 'approval_or_configuration_changed';
        return this.book.save(actor, p, 'blocked', { steps: outcomes });
      }
      this.book.assertLease(actor, p);
      outcome.status = 'dispatching';
      delete outcome.reason;
      p = this.book.save(actor, p, 'executing', { steps: outcomes });
      try {
        await provider.write(step.desired, before);
        const after = await provider.find(step.desired.externalId);
        if (!after || digest(project(after)) !== digest(step.desired))
          throw new Error('Readback mismatch');
        outcome.status = 'verified';
        outcome.evidence = {
          before: digest(before),
          after: digest(after),
          observedAt: new Date(this.store.now()).toISOString(),
        };
        p = this.book.save(actor, p, 'executing', { steps: outcomes });
      } catch {
        outcome.status = 'uncertain';
        outcome.reason = 'dispatch_or_readback_uncertain';
        return this.book.save(actor, p, 'uncertain', { steps: outcomes });
      }
    }
    return this.store.tx(() => {
      this.finishCatalog(actor, p);
      this.store.remove(actor.tenant, 'employee-lock', p.binding.data.employee.id);
      return this.book.save(actor, p, 'completed', {
        steps: outcomes,
        accessVerified: true,
        manualTasks: p.binding.data.tasks.map((title) => ({ title, status: 'open' })),
        scope: 'managed-scim-accounts-only',
      });
    });
  }
  async reconcile(actor: Identity, id: string) {
    requireRole(actor, 'operator');
    let p = this.book.get(actor, id);
    if (actor.subject === p.binding.requestedBy || actor.subject === p.reviewer)
      throw new Fault(403, 'independent_operator_required');
    if (!['uncertain', 'executing'].includes(p.status))
      throw new Fault(409, 'reconciliation_not_needed');
    if (Date.parse(p.updatedAt ?? p.binding.createdAt) + 30000 > this.store.now())
      throw new Fault(409, 'reconciliation_cooldown');
    p = this.book.fence(actor, p);
    const results = (p.result as { steps: StepResult[] } | undefined)?.steps;
    if (!results)
      return this.book.save(actor, p, 'blocked', {
        steps: p.binding.data.steps.map((s) => ({ provider: s.provider, status: 'pending' })),
        reason: 'expired-claim-before-dispatch',
      });
    for (let i = 0; i < results.length; i++) {
      const outcome = results[i]!,
        step = p.binding.data.steps[i]!;
      if (!['uncertain', 'dispatching'].includes(outcome.status)) continue;
      const provider = this.providers.find(
        (x) => x.config.alias === step.provider && x.config.tenant === actor.tenant,
      );
      if (!provider || provider.fingerprint !== step.providerHash)
        throw new Fault(409, 'provider_configuration_changed');
      try {
        const actual = await provider.find(step.desired.externalId);
        if (actual && digest(project(actual)) === digest(step.desired)) {
          outcome.status = 'verified';
          delete outcome.reason;
          outcome.evidence = {
            before: digest(step.before),
            after: digest(actual),
            observedAt: new Date(this.store.now()).toISOString(),
          };
        }
      } catch {}
    }
    const done = results.every((r) => r.status === 'verified');
    return this.store.tx(() => {
      if (done) {
        this.finishCatalog(actor, p);
        this.store.remove(actor.tenant, 'employee-lock', p.binding.data.employee.id);
      }
      return this.book.save(
        actor,
        p,
        done
          ? 'completed'
          : results.some((r) => ['uncertain', 'dispatching'].includes(r.status))
            ? 'uncertain'
            : 'blocked',
        {
          steps: results,
          accessVerified: done,
          verification: 'read-only-reconciliation',
          manualTasks: p.binding.data.tasks.map((title) => ({ title, status: 'open' })),
        },
      );
    });
  }
  manualTask(actor: Identity, id: string, input: unknown) {
    requireRole(actor, 'operator');
    const b = z
      .object({
        index: z.number().int().min(0).max(10),
        decision: z.enum(['completed', 'not-applicable']),
        note: z.string().min(10).max(1000),
      })
      .strict()
      .parse(input);
    return this.store.tx(() => {
      const p = this.book.get(actor, id);
      if (p.status !== 'completed') throw new Fault(409, 'access_verification_required');
      const result = p.result as {
        manualTasks: { title: string; status: string; decisionBy?: string; noteDigest?: string }[];
        workflowComplete?: boolean;
      };
      const task = result.manualTasks[b.index];
      if (!task) throw new Fault(404, 'manual_task_not_found');
      if (task.status !== 'open') throw new Fault(409, 'manual_task_already_reviewed');
      task.status = b.decision;
      task.decisionBy = actor.subject;
      task.noteDigest = digest(b.note);
      result.workflowComplete = result.manualTasks.every((t) => t.status !== 'open');
      this.store.audit(actor, 'manual-task.reviewed', 'completed', {
        id,
        index: b.index,
        decision: b.decision,
        noteDigest: task.noteDigest,
        scope: 'operator-attestation',
      });
      return this.book.save(actor, p, 'completed', result);
    });
  }

  private finishCatalog(actor: Identity, p: Plan<LifecycleData>) {
    const employee = this.store.need<Employee>(
      actor.tenant,
      'employee',
      p.binding.data.employee.id,
    );
    if (digest(employee) !== p.binding.data.employeeHash) throw new Fault(409, 'employee_changed');
    employee.department = p.binding.data.department;
    employee.employment = p.binding.data.action === 'offboard' ? 'departed' : 'active';
    this.store.put(actor.tenant, 'employee', employee.id, employee);
  }
  cancel(actor: Identity, id: string) {
    requireRole(actor, 'operator');
    return this.store.tx(() => {
      const p = this.book.get(actor, id);
      if (p.status !== 'blocked')
        throw new Fault(409, 'only_known_blocked_operations_can_be_cancelled');
      if (actor.subject === p.binding.requestedBy || actor.subject === p.reviewer)
        throw new Fault(403, 'independent_operator_required');
      this.store.remove(actor.tenant, 'employee-lock', p.binding.data.employee.id);
      return this.book.save(actor, p, 'rejected', {
        reason: 'known-pre-dispatch-block-cancelled',
        prior: p.result,
      });
    });
  }

  async drift(actor: Identity) {
    requireRole(actor, 'viewer', 'operator');
    const employees = this.employees(actor),
      observations: unknown[] = [];
    for (const provider of this.providers.filter((p) => p.config.tenant === actor.tenant)) {
      try {
        const accounts = await provider.list();
        for (const employee of employees.filter(
          (e) => e.employment === 'active' && !accounts.some((u) => u.externalId === e.id),
        ))
          observations.push({
            provider: provider.config.alias,
            externalId: employee.id,
            active: null,
            reasons: ['missing-managed-account'],
            source: provider.config.mode,
          });
        for (const u of accounts) {
          const employee = employees.find((e) => e.id === u.externalId);
          const reasons: string[] = [];
          if (!employee) reasons.push('orphaned-managed-account');
          else {
            if (u.active && employee.employment === 'departed')
              reasons.push('departed-user-active');
            if (!u.active && employee.employment === 'active') reasons.push('active-user-inactive');
            const expected =
              employee.employment === 'departed'
                ? []
                : [...policies.roles[employee.department]].sort();
            if (digest(u.roles.map((r) => r.value).sort()) !== digest(expected))
              reasons.push('entitlement-drift');
          }
          observations.push({
            provider: provider.config.alias,
            externalId: u.externalId,
            active: u.active,
            reasons,
            source: provider.config.mode,
          });
        }
      } catch {
        observations.push({ provider: provider.config.alias, status: 'unavailable' });
      }
    }
    return { scope: 'configured-managed-account-projections', observations };
  }
}
