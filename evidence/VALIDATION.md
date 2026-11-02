# Validation record

Recorded for the 1.0.1 source release on 2026-11-01, America/Vancouver. Results describe executed checks. Host tests used Node 26.3.0; the digest-pinned container independently runs the suite on Node 24. Browser tests use Playwright and a compatible local browser, while hosted CI installs the Playwright Chromium build.

| Check | Observed result | Evidence |
| --- | --- | --- |
| Formatting, strict types, tests, build and asserted demo | Passed | [verify.txt](verify.txt) |
| Automated tests | 38 passed, no failures or skips | [coverage.txt](coverage.txt) |
| Exercised source coverage | 95.99% lines, 88.59% branches | [coverage.txt](coverage.txt) |
| Browser workflows | 1 passed, desktop 1440px and mobile 390px checked, no page errors | [browser.txt](browser.txt), [desktop](../docs/dashboard.png), [mobile](../docs/dashboard-mobile.png) |
| Container build and Node 24 suite | Passed | [container-build.txt](container-build.txt) |
| Restricted container behavior | Passed with UID 1000, read-only root, dropped capabilities and bounded resources | [container-smoke.txt](container-smoke.txt) |
| Locked dependency advisory query | See recorded counts and versions | [dependencies.json](dependencies.json) |
| Reproducible domain demonstration | Assertions passed before output | [demo.json](demo.json), [demo execution](demo-run.txt) |

The coverage percentages include imported implementation modules. Startup configuration, main entrypoints, browser source and optional uninvoked CLI paths are not all included. Container and browser tests exercise additional startup and UI paths. Coverage and a green advisory query are not security or completeness scores. Advisory data changes, and the npm query does not scan every base-image package.

[Source manifest](source-manifest.json) fingerprints implementation, tests, build inputs, workflow, fixtures and dependency lockfile. Transcripts trim trailing whitespace only. Demo IDs, timestamps, audit hashes and timings vary. Public receipts contain only synthetic identity/device data and controlled lab outputs; actual workstation posture is omitted. Hosted CI status is linked from the README badge and is specific to its recorded commit.

The workflow demo uses actual local SCIM HTTP exchanges for list/filter/create/PATCH/ETag and native readback. Tests cover lost acknowledgements, partial outages, stale state, concurrency, competing employee locks, recovery fencing, a claim crashed before dispatch, independent identities, exact policy binding, manual attestations and restart replay. The security regressions also cover foreign-tenant fault denial and persistent tenant audit quotas. No external SaaS tenant, license API, session-revocation service, physical return or content transfer was accepted live.
