# Security policy

Version 1.x is supported. Report sensitive vulnerabilities through [private vulnerability reporting](https://github.com/jayekwere/workforceops/security/advisories/new). If unavailable, request a private reporting channel in an issue without exploit details or sensitive data.

Review the [threat model](docs/THREAT-MODEL.md), [architecture](docs/ARCHITECTURE.md), and [operations guide](docs/OPERATIONS.md). Prioritize authentication, tenant isolation, independent approvals, exact operation binding, credential disclosure, unsafe network targets, stale state, failure recovery and evidence integrity. Never run a proposed reproduction with real credentials or production targets.

Supply the affected commit, synthetic reproduction, crossed trust boundary, expected/observed behavior and practical impact. The issuer, service host, operator configuration and private credential stores are trusted. A local database chain does not isolate a compromised host administrator. Tests validate stated properties, not a security certification.
