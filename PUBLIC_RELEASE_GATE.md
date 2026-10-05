# Community Preview 0.1 — local release gate

**Overall: FAIL — not approved for publication.** Reviewed 2026-10-04. No GitHub repository, remote, release or tag was created. The private repository is unchanged.

| Gate | Result | Evidence / limitation |
| --- | --- | --- |
| Current-source secret audit | PASS | Committed baseline scanned; retired prototype credential-shaped material and internal operational records excluded. |
| Private-history credential review | PASS | All 1,138 reachable blobs scanned; independent Gitleaks review covered 18 commits. Redacted findings and a rotation/restriction-review recommendation retained privately; no credentials tested or changed. |
| Public-candidate secret scan | PASS | Repository scan and Gitleaks staged-tree scan have zero findings after synthetic-canary cleanup. |
| Owner-data scan | PASS | Export allowlist, fixture review and private-indicator comparisons found no retained owner data. Approved copyright attribution is intentional. |
| Path scan | PASS | Shipped JavaScript and native helpers contain no detected private build paths; PDB path embedding disabled. |
| Dependency-license audit | FAIL | npm runtime/bundled-code licenses and notices inventoried, but Electron/FFmpeg and native runtime redistribution obligations remain unresolved. See runtime license review. |
| Asset-license audit | PASS | Owner confirmed project control and MIT distribution for icon, Mo and Home artwork. OFL font notices included; stock/vendor reference assets excluded. |
| First-run clean profile | PASS | Actual packaged app opened with an empty disposable profile. No keys, Google account, tasks, runs, places, routes, clocks, flights, devices, mapping, remembered permission or Relay responsibilities; observation/background work off. |
| First-run network audit | FAIL | Complete Chromium startup/navigation netlog recorded no external hosts. Native startup instrumentation did not produce a successful observation; native traffic coverage is incomplete. |
| Public tests | PASS | 1,093 tests across 88 files; 46 separate Relay tests. Four workers bound test-run contention. |
| Typecheck and lint | PASS | Passed in public candidate. |
| Clean-source build | PASS | Fresh staged-source export inside the candidate installed its own dependencies and built both native helpers and production bundles. |
| CI configuration | PASS | Windows install/setup, typecheck, lint, tests, build and source/runtime scans configured. Hosted execution is unverified until a repository exists. |
| Public package allowlist | PASS | 289 extracted ASAR files; only explicit runtime roots. Dependency copies limited to SQLite and its required package; bundled-code notices retained. |
| app.asar scan | PASS | Extracted content scanned; 30 project-owned runtime files matched build hashes, including both native helpers. |
| Executable/resource scan | PASS | No unresolved findings. 43 binary/locale pattern matches also occur in the fresh upstream Electron distribution; reviewed using byte/fingerprint comparisons. |
| README/docs review | PASS | Architecture, setup, security, contribution, status, roadmap, branding, history, asset and release documentation prepared with known limits stated. |
| MIT LICENSE readiness | PASS | Owner confirmed exact holder wording; standard MIT grant and 2026 notice present. |
| Branding review | PASS | Recognizable project identity retained, no registration/partnership claims; derivative-status guidance present. |
| Public screenshot set | FAIL | One reviewed empty Dashboard/Mo capture retained. Automated module navigation did not yield valid distinct captures; mislabeled images excluded. |
| Windows artifact | PASS | Public-source Windows x64 directory built; unsigned local review artifact only. |
| Checksums | PASS | SHA-256 accompanies the local candidate ZIP and executable. |

## Next decision

Resolve the three failed gates before requesting publication approval. Git identity is provisional until the owner confirms a public identity. GitHub namespace, exact repository name and explicit publication approval remain pending. Proposed name: `momo-ai`; proposed tag: `community-preview-0.1`.

No private Git history is imported. Evidence, excluded-file manifest, provider findings and owner fingerprints are outside the public repository's tracked content. Local verification profiles, caches, dependencies and release outputs are ignored and excluded from source publication.
