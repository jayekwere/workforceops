# API

Bearer access tokens are required on every `/api/*` route. Request bodies are strict JSON. Caller-supplied tenant, endpoint, credential, command or unrecognized operation fields are rejected.

| Route                                               | Role                       | Contract                                                                            |
| --------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/me`                                       | Registered subject         | Server-owned subject, tenant, roles                                                 |
| `GET /api/overview`, `/api/employees`, `/api/plans` | Workflow/view roles        | Tenant data, providers without credentials, scoped plans and recent evidence        |
| `POST /api/plans`                                   | Requester                  | `{employeeId, action: onboard/change-role/offboard, department?}`                   |
| `GET /api/plans/:id`                                | Registered subject         | Scoped exact plan or 404                                                            |
| `POST /api/plans/:id/review`                        | Independent reviewer       | `{digest, approve}`                                                                 |
| `POST /api/plans/:id/execute`                       | Independent operator       | `{digest, key}`                                                                     |
| `POST /api/plans/:id/reconcile`                     | Independent operator       | Read-only provider reconciliation after cooldown                                    |
| `POST /api/plans/:id/cancel`                        | Independent operator       | Cancel known blocked operation only                                                 |
| `POST /api/plans/:id/manual-task`                   | Operator                   | `{index, decision: completed/not-applicable, note}` after access verification       |
| `GET /api/drift`                                    | Viewer, operator           | Complete bounded managed-account reconciliation or explicit provider unavailability |
| `GET /api/audit`                                    | Viewer, reviewer, operator | Recent tenant evidence and full database-chain verification                         |
| `POST /api/demo/fault`                              | Operator, demo only        | `{provider: directory/collaboration, unavailable, loseAcknowledgement?}`            |

Operation keys are 8 to 100 letters, digits or hyphens. Plan IDs are UUIDs. Manual notes are 10 to 1,000 characters and only their digest is retained in the decision. Each manual task can be reviewed once. The completed plan status concerns managed access; inspect `manualTasks` and `workflowComplete` for additional attested decisions. No manual task proves a physical action.

Typical errors are 400 invalid contract, 401 invalid token, 403 role or independence failure, 404 foreign/unknown record, 409 changed state/digest/expiry/lock, 413 oversized input, 429 rate limit and 502 unavailable/invalid upstream response. A 200 workflow response can carry blocked or uncertain status and must not be interpreted as all steps completed. Read the per-step statuses and evidence.
