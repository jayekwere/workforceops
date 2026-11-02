# Contributing

Use Node 24, locked dependencies, and synthetic data. Run `npm ci --ignore-scripts`, `npm run verify`, browser checks after `npx playwright install chromium`, and the restricted container smoke test. Include a failure-inducing regression test when changing identity, approval, tenant, network, state, or verification boundaries. Keep integration contracts separate from live acceptance receipts.

Explain changed behavior, failure handling, validation performed, and remaining uncertainty. Never include credentials, personal records, proprietary material, employer references, or long dash punctuation. Do not weaken verification to make CI pass. Update documented integration scope when behavior changes.
