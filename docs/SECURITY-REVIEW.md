# Security review and remediation

Source release: **1.0.1**. Reviewed baseline: [aa7a2fd](https://github.com/jayekwere/workforceops/tree/aa7a2fd064803883c46e4451d662e729f46803dc).

The review covered application source, API and browser boundaries, startup/configuration, storage, tests, fixtures, container and CI definitions. It used a fresh independent baseline reviewer and architecture reviewer, parent source validation, a pre-patch compatibility investigation and one fresh patch-review cycle. This was an agent-assisted source review with synthetic validation. No independent external penetration test or live provider acceptance was performed. Third-party package internals were not fully audited; generated receipts and visual assets received targeted review.

| Confirmed issue                                               | Severity | Remediation                                                                                                                             |
| ------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Foreign-tenant operator could change sandbox SCIM fault flags | Low      | Resolve the local provider through authenticated tenant and alias, reject foreign ownership and audit accepted changes before mutation. |

The original regression returned HTTP 200 where 403 was required. The patched test rejects both provider aliases and both fault flags from the isolated operator, preserves state, verifies owning-operator success and real provider readback. Shared per-tenant audit budgets were propagated from the EndpointOps resource fix. The external-write, uncertain-dispatch and read-only recovery semantics remain covered by the lifecycle suite.

## Validation

The patched source passed formatting, strict types, build, 38 automated tests, 1 browser workflows and its restricted container demo. Containers independently repeat the suite under Node 24; host runs use Node 26. The recorded locked-dependency query reports zero advisories, which is time-sensitive and does not scan every base-image package. [Validation record](../evidence/VALIDATION.md), [test/coverage transcript](../evidence/coverage.txt), [browser results](../evidence/browser.txt), [container results](../evidence/container-smoke.txt) and [source fingerprints](../evidence/source-manifest.json) retain the evidence. Hosted CI is linked from the README and must be assessed for its exact commit.

## Capacity and deployment limits

Audit history retains a 100,000-entry global cap and a 10,000-entry tenant cap. Counts derive from complete persisted history, so restart cannot clear them. The existing audit body/HMAC format is retained and indexes are additive. A database already beyond a new limit remains readable and verifiable but refuses affected new audited mutations. One tenant cannot consume an otherwise empty global budget, but many tenants or legacy history can still reach the shared bound. This is bounded reference-service storage, without automatic archive, quota reset or state migration. Preserve authenticated history and operational state during reviewed maintenance. External effects cannot be undone by a later SQLite capacity failure. See [operations](OPERATIONS.md).

SCIM roles are the implemented account projection. External tenant acceptance, session revocation, group/license handling and physical manual decisions remain outside the validated scope.

The issuer, host, trusted configuration, TLS termination, private credentials and independent audit checkpoints remain deployment responsibilities. Coverage and passing tests establish the checked behavior; they do not certify every possible input or deployment. Copied documentation claims were corrected to match this repository's implemented interfaces.
