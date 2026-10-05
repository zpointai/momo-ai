# Community Preview 0.1 — local handoff

**Overall FAIL: one native-runtime licensing item remains. Nothing has been published.**

This public candidate uses a separate Git history on main with 596 tracked files. Starting public commit: 79d49ad303617ed420052f76f5ae341b39cb20f4. The gate-closure commit is the commit containing this report; obtain its exact ID with `git rev-parse HEAD`. The private owner handoff records that resolved ID and the tracked-file count after commit.

| Item | Result |
| --- | --- |
| Runtime inventory | Ten native binaries. Electron 44.4.3, Chromium 152.0.7977.130, Node 24.21.0; FFmpeg pinned Chromium fork; better-sqlite3 13.0.3 / SQLite 3.53.4; six graphics/media DLLs and two project helpers. [Exact versions, files and terms](docs/RUNTIME_REDISTRIBUTION.md), [binary hashes](docs/RUNTIME_BINARIES.json). |
| License gate | FAIL only for proprietary MSVC v142 runtime objects in the two helpers. Owner confirmed standalone Build Tools only / unsure. Verify applicable distribution rights or authorize a validated rebuild using a toolchain with an established grant. |
| Notices/source | Canonical Electron/Chromium notices unchanged. FFmpeg source, Electron patch, pinned build inputs and replacement instructions accompany the DLL. npm, font, SDK and STL notices retained. |
| Network | PASS: main-process API instrumentation, full Chromium netlog, Windows PID observation and separate loopback main/child canaries. No native product requests or owner services. Basemap and system DNS/proxy/reachability activity documented. |
| Screenshots | PASS: Dashboard, Mo, Work, Inbox, Planner, Situation, Relay, Home, Settings; all fresh and individually reviewed. [Gallery/provenance](docs/SCREENSHOTS.md). |
| Security / privacy | Source scanner clear; Gitleaks findings are reviewed unchanged upstream source tokens, not credentials. Owner indicators/private paths clear. 283 ASAR files and 30 own runtime hashes verified; 43 upstream Electron pattern matches reviewed. |
| Validation | 1,093 product tests in 88 files, 46 Relay tests, typecheck, lint and Windows build passed. Previous independent clean dependency install remains valid: lockfiles/dependency versions unchanged. |
| ZIP | MoMo-Community-Preview-0.1-Windows-x64.zip; 188,380,124 bytes; 150 entries verified against packaged files. Local review only. |
| Signing | NotSigned. No signing certificate or publishing infrastructure changed. |
| Retired credentials | Retired prototype material absent from public source/history/runtime. Owner should review and rotate or restrict if still live; no credential tested, printed, rotated or revoked. |
| Publication state | No remote, tag, release, GitHub authentication or repository creation. Public Git author remains provisional. |

ZIP SHA-256: `1946b5871eebface8d64e97deb6a933c6e3463f3f03e0cefbd4d7a30ccbc3156`

EXE SHA-256: `d67dd989af7cbdc0938583f2751d344caa5eab591ab4a9a5ff4320d28b368337`

Before publication: resolve the runtime gate, confirm GitHub namespace and exact repository name, confirm public author name and Git email (GitHub noreply is suitable), then obtain explicit publication approval. Copyright holder and permission to distribute project artwork under MIT are already confirmed. Do not rewrite author history or publish before those confirmations.
