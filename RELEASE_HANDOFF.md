# Community Preview 0.1 — release handoff

**All local release gates PASS. Private staging created; ready for owner public-publication approval.**

1. Starting public commit: 413dce3fa3de244a730a35696e5575a4c9e914d4.
2. Current staging commit: obtain with `git rev-parse HEAD`. Exact resolved ID and commit count are recorded in the private owner handoff. Sanitized history includes release preparation and staging validation updates; private history is not imported.
3. Runtime inventory: ten native binaries. Electron 44.4.3; Chromium 152.0.7977.130; Node 24.21.0; six supplied media/graphics DLLs; SQLite 3.53.4 via better-sqlite3 13.0.3; two project helpers. [Exact matrix](docs/RUNTIME_REDISTRIBUTION.md), [hash inventory](docs/RUNTIME_BINARIES.json).
4. Electron: MIT grant retained unchanged as LICENSE.electron.txt.
5. Chromium: complete upstream LICENSES.chromium.html retained unchanged, including bundled Node/graphics/component grants.
6. FFmpeg: LGPL 2.1+; exact corresponding source, Electron patch, LGPL text and rebuild/replacement instructions included with its replaceable DLL.
7. Native runtime: resolved using verified LLVM-MinGW 20260922 / LLVM 23.1.2. No proprietary MSVC runtime in either project helper; dynamic OS UCRT imports. Exact runtime notices and declaration/helper sources supplied. Unchanged Electron D3D compiler retains separate SDK terms. [Build details](docs/NATIVE_BUILD.md).
8. Notices: LLVM component grants, MinGW aggregate and linked-source notices added; obsolete Microsoft STL notice removed. THIRD_PARTY_NOTICES and runtime matrix updated; FFmpeg and other resolved notices preserved.
9. Dependency-license gate: PASS.
10. Native instrumentation: hooks installed before first main-module statement; fetch/undici, HTTP/S, TCP/TLS, DNS, UDP, WebSocket, child processes, Windows PID ancestry/socket polling; proven API and main/child loopback canaries.
11. Chromium network: public OpenFreeMap basemap requests plus classified Windows DNS/WPAD and Chromium IPv6 reachability activity.
12. Native/process result: no native product requests or product child launches; storage worker observed; 50 PID socket/process samples, including main/child canary connections.
13. First-run network gate: PASS. Empty disposable profile, all nine views, complete Chromium netlog, no owner services or credentials.
14. Unexpected destinations: none unresolved. Network behavior did not need a product change. [Scope and limitations](docs/NETWORK_AUDIT.md).
15. Screenshot harness: correct route/heading/pane assertions and process-local synthetic Home/Relay/Situation fixtures; final package/main/renderer hashes recorded. Fixtures are excluded from production.
16. Screenshots: Dashboard, Mo, Work, Inbox, Planner, Situation, Relay, Home, Settings. [Gallery](docs/SCREENSHOTS.md).
17. Visual review: all nine latest 1920×1080 images individually viewed; distinct routes/panes, no private account/device data or duplicate hashes.
18. Screenshot gate: PASS.
19. Secret scan: source clear; staged closure changes clear. Three vendor and one history matches are reviewed unchanged upstream code/revision tokens, not credentials.
20. Owner-data scan: PASS; nine private anchor comparisons clear. Approved copyright attribution is intentional.
21. Path scan: PASS; no detected private source/build paths in shipped project code/helpers.
22. Package scan: PASS; 293 ASAR files, 30 own runtime hashes, ten native binaries. Canonical notices and helper sources match originals. The 43 binary/locale pattern matches are verified upstream Electron data; no unresolved findings. All 179 ZIP entries match the packaged directory.
23. Validation: 1,093 tests / 88 files and 46 Relay tests passed; typecheck/lint passed; fresh independent dependency/toolchain installation and Windows build passed. Actual native COM/protocol/denial/resource/hardening smoke tests passed. Hosted Windows results: [workflow](https://github.com/zpointai/momo-ai/actions/workflows/ci.yml). The exact validated commit/result is retained in the private owner evidence.
24. Windows artifact: [MoMo-Community-Preview-0.1-Windows-x64.zip](release/MoMo-Community-Preview-0.1-Windows-x64.zip), 188,746,026 bytes.
25. ZIP SHA-256: `77cd6025a324f2704596ef52c459286979ef42227f89e124f48776991c68f21e`.
26. EXE SHA-256: `f96a7ca232f48696dbf785e26da1d4f918a9fc2076de5a2dc356ed9389b11f1d`. [Checksum file](release/SHA256SUMS.txt).
27. Signing: NotSigned; unsigned Community Preview, no signing infrastructure changed.
28. Firebase: owner confirmed retired web-prototype use. Its code/configuration remains excluded; no public dependency or startup request. No credential tested or account modified. If the old project/key is still used elsewhere, restrict or retire it separately; it is not a publication dependency.
29. [PUBLIC_RELEASE_GATE](PUBLIC_RELEASE_GATE.md): overall PASS; no technical blockers remain.
30. Public candidate: 613 tracked files on main; clean after this commit. Raw evidence, profiles, caches, dependencies and build outputs remain ignored.
31. Owner-authorized private staging repository [zpointai/momo-ai](https://github.com/zpointai/momo-ai) exists; origin is configured and main is pushed. No tag, release or public visibility change was made. Private MoMo baseline and history are unchanged.
32. Confirmed on 2026-10-05: repository target `zpointai/momo-ai`; public Git author `Zlatin Gorov <211139952+zpointai@users.noreply.github.com>`. Private repository creation and pushing main were explicitly approved and completed. Public visibility, tagging and release publication still require separate approval. Copyright holder and MIT artwork permission are already confirmed. All prepared commits and staging updates use the confirmed author and committer identity.
