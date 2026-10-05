# Community Preview 0.1 — local release gate

**Overall: FAIL — not approved for publication.** Reviewed 2026-10-04. No GitHub repository, remote, release or tag was created. The private repository is unchanged.

| Gate | Result | Evidence / limitation |
| --- | --- | --- |
| Current-source secret audit | PASS | Committed baseline scanned; retired prototype credential-shaped material and internal operational records excluded. |
| Private-history credential review | PASS | All 1,138 reachable blobs scanned; independent Gitleaks review covered 18 commits. Redacted findings and a rotation/restriction-review recommendation retained privately; no credentials tested or changed. |
| Public-candidate secret scan | PASS | Repository scan: zero findings. Gitleaks staged changes and complete vendor archive: three reviewed upstream code/revision false positives; no unresolved credentials. |
| Owner-data scan | PASS | Export allowlist, fixture review and private-indicator comparisons found no retained owner data. Approved copyright attribution is intentional. |
| Path scan | PASS | Shipped JavaScript and native helpers contain no detected private build paths; PDB path embedding disabled. |
| Dependency-license audit | FAIL | Exact ten-binary inventory complete; Electron/Chromium/Node/graphics/SQLite notices and FFmpeg source resolved. MSVC runtime redistribution entitlement for the two static helpers remains unverified; owner confirmed standalone Build Tools only / unsure. [Runtime matrix](docs/RUNTIME_REDISTRIBUTION.md). |
| Asset-license audit | PASS | Owner confirmed project control and MIT distribution for icon, Mo and Home artwork. OFL font notices included; stock/vendor reference assets excluded. |
| First-run clean profile | PASS | Actual packaged app opened with an empty disposable profile. No keys, Google account, tasks, runs, places, routes, clocks, flights, devices, mapping, remembered permission or Relay responsibilities; observation/background work off. |
| First-run network audit | PASS | Before-first-statement native API observer, full Chromium netlog and 51 PID socket/process samples; all native API canaries and main/child OS canaries passed. No native product requests. Public basemap, Windows DNS/WPAD and Chromium IPv6 probes classified; no owner infrastructure. [Audit](docs/NETWORK_AUDIT.md). |
| Public tests | PASS | 1,093 tests across 88 files; 46 separate Relay tests. Four workers bound test-run contention. |
| Typecheck and lint | PASS | Passed in public candidate. |
| Clean-source build | PASS | Fresh staged-source export inside the candidate installed its own dependencies and built both native helpers and production bundles. |
| CI configuration | PASS | Windows install/setup, typecheck, lint, tests, build and source/runtime scans configured. Hosted execution is unverified until a repository exists. |
| Public package allowlist | PASS | 283 extracted ASAR files; only explicit runtime roots. Dependency copies limited to SQLite and its required package; bundled-code notices retained. |
| app.asar scan | PASS | Extracted content scanned; 30 project-owned runtime files matched build hashes, including both native helpers. |
| Executable/resource scan | PASS | No unresolved findings. 43 binary/locale pattern matches also occur in the fresh upstream Electron distribution; reviewed using byte/fingerprint comparisons. |
| README/docs review | PASS | Architecture, setup, security, contribution, status, roadmap, branding, history, asset and release documentation prepared with known limits stated. |
| MIT LICENSE readiness | PASS | Owner confirmed exact holder wording; standard MIT grant and 2026 notice present. |
| Branding review | PASS | Recognizable project identity retained, no registration/partnership claims; derivative-status guidance present. |
| Public screenshot set | PASS | Nine fresh, distinct 1920×1080 captures from the final current build; route/heading/pane assertions, hashes and individual visual review passed. Synthetic fixtures only; no live account/device. [Gallery](docs/SCREENSHOTS.md). |
| Windows artifact | PASS | Public-source Windows x64 directory built; unsigned local review artifact only. |
| Checksums | PASS | SHA-256 accompanies the local candidate ZIP and executable. |

## Next decision

Resolve the one remaining MSVC helper-runtime licensing gate before requesting publication approval. Native network observation and all screenshots are complete. No previously passing gate was downgraded. Git identity is provisional until the owner confirms a public identity. GitHub namespace, exact repository name and explicit publication approval remain pending. Proposed name: `momo-ai`; proposed tag: `community-preview-0.1`.

No private Git history is imported. Evidence, excluded-file manifest, provider findings and owner fingerprints are outside the public repository's tracked content. Local verification profiles, caches, dependencies and release outputs are ignored and excluded from source publication.
