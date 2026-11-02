# Design decisions

## Small, inspectable services

Use strict TypeScript, Zod contracts, Fastify, SQLite, signed access tokens and locally compiled browser assets. Avoid distributed queues, automatic AI decisions, arbitrary scripts and large frontend frameworks. The resulting single-node boundary is explicit. The three repositories use the same small security scaffold but independent domain engines, lockfiles and releases. Each repository remains runnable on its own; a shared security fix must be reviewed and propagated to each copy.

## Server-owned authority

The identity registry maps verified subjects to tenant and roles. Tokens authenticate subjects but cannot supply new permissions. Every storage lookup includes the server tenant. Explicit independent identities authorize changes. Demo role switches test identifiers, not independent humans. Operator configuration, the issuer and the host remain trusted.

## Facts before positive claims

Missing observations remain unknown. A successful HTTP response is not proof of a downstream business outcome. External responses receive strict shape, identity and size checks. Post-operation readback supports a specific observed state at a specific time. Uncertain external effects are not silently retried. Recorded durations describe the scripted lab, not human productivity or live reliability.

## Explicit evidence boundaries

Keep request, policy, configuration and result fingerprints alongside audit events. Do not log credentials or arbitrary raw upstream payloads. Render user-provided strings with text nodes. No external fonts, telemetry, model-generated authorization or browser credential storage are needed. A local authenticated chain detects particular modifications; independent retention is a separate operational requirement.
