# Threat model

Protect account-change authority, catalog and provider identity, independent approval, tenant records, credentials, dispatch state and audit integrity. Trust the issuer for authentication and operator-maintained registry/policy/configuration for authorization. Clients, arguments and provider responses are untrusted. Host administrators and compromised provider administrators remain outside the local isolation boundary.

| Threat                                 | Control and evidence                                                                       | Residual limit                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Forged token or promoted role/tenant   | Asymmetric verification, claim constraints, server registry, negative tests                | Stolen bearer token remains usable until expiry                                     |
| Self-approved access change            | Requester/reviewer/operator subject checks, including combined-role tests                  | Independently controlled people are a provisioning requirement                      |
| Wrong employee or remote account       | Tenant catalog lookup, exact external ID/userName, pinned endpoint and safe IDs            | Trusted operator can change configuration; upstream authority needs least privilege |
| Stale or changed approval              | Canonical binding, policy/employee/provider/before-state fingerprints, expiry, ETag        | Remote administrators can race outside the service                                  |
| Duplicate or concurrent dispatch       | Immediate claim, execution key, durable employee lock, per-step evidence and lease fencing | External effects are not a local transaction                                        |
| Timeout causes destructive retry       | Dirty steps become uncertain, retain lock and reconcile read-only                          | Matching native state does not identify the cause of an unacknowledged change       |
| Cross-tenant record lookup             | Every storage path derives tenant from server identity                                     | A host operator can read all local data                                             |
| Secret forwarding or script injection  | Separate provider credential, fixed URLs, no redirects, text-node rendering, CSP           | Upstream data and deployment egress remain trust concerns                           |
| History rewrite or capacity exhaustion | HMAC chain, startup verification, bounded bodies/records/rates and hard audit capacity     | External checkpoints, archive and host security are required                        |

Security invariants: no unauthorized lifecycle dispatch; exact, independent approval; no dirty-step auto retry; completed steps stay completed on replay; an unresolved employee cannot receive a competing workflow; readback supports only the implemented account projection; manual tasks remain labeled attestations. No claim covers all cached sessions, provider licenses, physical equipment or a full HR lifecycle outside the implemented boundary.
