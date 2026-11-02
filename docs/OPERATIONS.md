# Operations and deployment

## Local demonstration

Use Node 24.13 or later through Node 26, npm, and a trusted workstation. Install locked dependencies with `npm ci --ignore-scripts`, run `npm run build`, then `DEMO=1 npm start`. Open `http://127.0.0.1:4410`. The console prints disposable, signed access tokens for requester, reviewer, operator, viewer and an isolated tenant. They expire after fifteen minutes. Restart for fresh tokens.

The browser keeps the active token in memory and a password field. It uses no cookies, browser storage, external fonts, analytics, or external script assets. Clearing the field does not disconnect an already active in-memory session; use Disconnect or reload to clear all state. The demo proves separation of subject identifiers; one person controlling all demo tokens does not prove independent human approval. Provision independently controlled credentials to establish separation between people.

`docker compose up --build` runs the same local demo. Read disposable tokens with `docker compose logs`; restrict log access. `docker compose down` stops it. Compose publishes only to loopback, uses a non-root user, a read-only filesystem, dropped capabilities, no-new-privileges, process/memory/CPU limits, and bounded temporary storage. Demo state is ephemeral. The local SCIM fault lab requires in-memory core state because its endpoints have an ephemeral lifecycle. No host Docker socket is mounted. No demo makes a billable cloud resource or modifies a physical device.

## Configured service

Demo mode is enabled only by `DEMO=1`. Otherwise startup requires an HTTPS external `BASE_URL`, an `AUTH_CONFIG` file and a stable random `AUDIT_KEY` of at least 32 bytes. Generate secrets from a cryptographic random source, supply them privately through your deployment secret mechanism, and never commit them. `DB_PATH` defaults to `.data/state.sqlite`. Mount a private writable parent directory for UID 1000 if running configured mode in a container. `HOST` defaults to `127.0.0.1`; the image sets `0.0.0.0`. `PORT` defaults to 4410.

`BASE_URL` must be an origin without a path, query, fragment or credentials. Terminate TLS at a trusted reverse proxy, preserve that external Host header, strip untrusted forwarding headers, and keep the internal listener private. The app does not trust forwarded client addresses. Its IP limiter sees the proxy address, so apply suitable per-client and connection limits at the edge as well.

The authentication file has this shape. The empty keys array deliberately fails. Replace it with actual public ES256 or RS256 keys from your chosen issuer.

```json
{
  "issuer": "https://issuer.example.invalid/realm",
  "audience": "https://operations.example.invalid",
  "jwks": { "keys": [] },
  "identities": [
    { "subject": "request-subject", "tenant": "sandbox", "roles": ["requester", "viewer"] },
    { "subject": "review-subject", "tenant": "sandbox", "roles": ["reviewer", "viewer"] },
    { "subject": "operate-subject", "tenant": "sandbox", "roles": ["operator", "viewer"] }
  ]
}
```

The audience must equal the external origin. Demo audiences are repository names. Required access-token fields are `sub`, `iat`, `exp`, and nonempty `jti`, with `typ=at+jwt`. Only ES256/RS256 signatures are accepted. Expected issuer and audience, expiry, maximum age and `nbf` when supplied are verified. Maximum lifetime and age are fifteen minutes with two seconds of clock tolerance. A `jti` requirement does not make a bearer token single-use. Possession permits reuse during validity. Roles and tenant claims in tokens cannot override the server identity registry. Subject IDs must be unique within the configured issuer.

The service verifies a local public JWKS snapshot. There is no built-in issuer, browser OAuth login, automatic discovery, key refresh, introspection, proof of possession or immediate token revocation endpoint. Replace the configuration and restart to change registry mappings or verification keys. Remove old keys after the intended overlap. Private verification keys and symmetric JWKS entries are rejected. The configuration must not be group or world writable. Use restrictive owner-only permissions for any configuration containing private operational data.

## Request and authority boundaries

All `/api/*` paths require access tokens. `/health` is public liveness, not a provider-readiness assertion. Static files contain no tenant state. Host and browser Origin must match the configured external origin. No permissive CORS is enabled. Strict CSP, no-store, no-referrer, MIME protection and permissions headers apply. The app caps bodies at 256 KiB, tokens at 8 KiB, requests at 120 per subject and 480 per observed IP per minute, and limiter key counts at 4,096 per map. Limits are per process.

Sensitive changes use separate requester, reviewer and operator subjects. A subject carrying multiple roles cannot approve or execute its own request or execute a plan it approved. Plans bind canonical operation data, tenant, requester, policy hash and a fifteen-minute expiry. Review checks the exact digest. Execution keys bind plan, digest and operator. Reusing a completed operation key returns stored status; a different actor or operation is refused. These controls authorize defined operations, not arbitrary commands or caller-selected URLs.

## Persistence, evidence and recovery

SQLite runs with WAL, a five-second busy timeout and immediate transactions. Nested operations use savepoints. Use a single service process and local disk; do not use network filesystems or assume a distributed deployment. Newly created state directories use 0700 and the database uses 0600. Secure existing parent directories, WAL companions, backups and the host account. The database is not encrypted by this application.

The audit HMAC chain authenticates global sequence, timestamp, tenant, actor, action, outcome, details and previous hash. Startup verifies it, and the evidence endpoint can verify it again. Edits, incorrect keys and middle deletions are detected. A valid historical rollback or suffix truncation needs an independent checkpoint to detect. A host administrator with the key can forge history. Retain sequence/hash checkpoints outside the service under separate control. Per-tenant exports may omit intervening entries from other tenants and are not complete standalone global chains.

Audit history has a 100,000-entry global bound and a 10,000-entry per-tenant bound. Counts use complete persisted audit rows, including after restart. A single tenant starting below the normal bounds cannot spend the entire global budget. These quotas do not promise global headroom for arbitrarily many tenants or a legacy database already close to full. New audited mutations fail closed with HTTP 507 at the applicable limit.

Monitor disk, global and tenant consumption before reaching a bound. Exhaustion is a maintenance stop. Preserve the authenticated database, SQLite WAL state, private key and independently held sequence/hash checkpoint. Use SQLite online backup tooling or stop the service before a consistent backup. Test recovery before relying on it. There is no automatic archive, encrypted backup, in-place history deletion, quota reset or state-migration endpoint. Do not discard credentials, replay records, approvals, employee locks or unresolved operation state to reclaim capacity. Any controlled migration requires its own reviewed procedure and acceptance evidence. A quota failure after an external write cannot undo that write; retain dispatch state and investigate read-only before maintenance.

## Verify and release

Run `npm run verify` for formatting, strict types, automated tests, web build and the asserted CLI demo. `npm run coverage` reports exercised V8 source coverage, not a security score. `npx playwright install chromium` installs the test browser; then run `npm run test:browser`. `CHROME_PATH` can select a compatible local browser. CI installs its own Chromium build. Build `docker build -t workforceops:local .` and run `node scripts/container-smoke.mjs workforceops:local` with port 4410 free. It starts the real image with runtime restrictions, checks behavior and removes its temporary container.

CI uses read-only repository permissions, full action commit SHAs, disabled persisted checkout credentials, a locked install with lifecycle scripts disabled, type/test/demo/browser checks, dependency advisory query, container build and restricted smoke checks. The image base is digest pinned. Publishing a source release does not deploy a public service or attest external provider acceptance. Dependency advisory data and base-image safety change over time. Maintain the pinned versions and rerun validation when updating them.
