# Packaged first-run network audit

**PASS — bounded local observation on 2026-10-04.** The current Windows package was launched with an empty disposable profile, only normal OS environment variables, and no integration configuration. All nine views were visited: Dashboard, Mo, Work, Inbox, Planner, Situation View, Relay, Home Automation and Settings. No product source or network behavior was changed.

## Observation and proof

`scripts/release-audit/first-run.mjs` starts the actual packaged EXE with a loopback debugger paused before its first main-module statement. The paused script must equal the current main build. Pass-through hooks observe Node fetch/undici, HTTP, HTTPS, TCP, TLS, DNS callback/promise/resolver APIs, UDP, WebSocket and child-process creation. The storage worker receives an explicit argument list omitting the audit debugger flag, avoiding an inherited debugger pause. Its production code is unchanged.

Complete Chromium netlog runs from process launch through graceful shutdown. Windows CIM process ancestry and PID-filtered TCP/UDP queries observe the application and descendants; there is no packet driver, firewall change, payload recording or unrelated socket logging. The final run collected 51 process/socket samples. Product navigation lasted about 22 seconds, including two seconds after each verified view transition; initialization and shutdown are also observed.

After the product window, a separately labelled loopback canary exercises fetch, HTTP, HTTPS/TLS (intentional local handshake failure), TCP, DNS lookup and a loopback DNS responder, UDP and WebSocket. Every API family was recorded. A held TCP connection from the main process and another from a short-lived Node child were both detected by Windows socket observation. Canary events are excluded from product findings. Audit scripts and raw traces are excluded from the shipped application.

## Findings

| Surface / trigger | Observed behavior | Disposition |
| --- | --- | --- |
| Native main process, startup and all views | Zero native API network attempts; no product-spawned child processes | No credentialed provider, Relay, device discovery or owner endpoint contact |
| Storage worker | SQLite worker created; source uses local SQLite/message passing; OS observation covers its process | No networking dependency identified |
| Optional native helpers | Neither helper launched during unconfigured navigation; source/import review has no direct networking library; Relay setup is explicit user action | No helper first-run traffic; this is not a configured-integration test |
| Situation View | HTTPS requests to `tiles.openfreemap.org`; OS observed the corresponding public CDN connection on port 443 | Intentional unauthenticated basemap/style/font/tile loading; it discloses the client's IP and requested map area to the service. No provider key or owner place supplied |
| Chromium proxy discovery | Windows WPAD/DHCP discovery and `wpad` resolution, unsuccessful in this run | Inherited Windows proxy configuration, not a private MoMo endpoint |
| Chromium DNS | Queries to the DNS resolver in Windows configuration | Normal name resolution; local resolver address retained only in private evidence |
| Chromium IPv6 reachability | UDP connect to `[2001:4860:4860::8888]:443` | Chromium's route/reachability probe; source performs connect/local-address inspection, not a MoMo Google account request |
| Audit infrastructure | Loopback inspector/CDP connections and labelled synthetic canaries | Explicit audit-only traffic; no external canary service |

All observed request hosts and connection destinations were classified. No owner Fly/Twilio/Google/AI credentials, Hue/Govee device, private Relay endpoint or other owner service was contacted. No inappropriate product-native call was found, so no production fix was made. The earlier report of no Chromium hosts is superseded by this complete run; opening Situation View does load the public basemap.

Chromium's [pinned resolver implementation](https://github.com/chromium/chromium/blob/152.0.7977.130/net/dns/host_resolver_manager.cc) identifies its IPv6 probe target and connect/local-address procedure. The source of the basemap request is the current Situation renderer.

## Limits and reproduction

Run `node scripts/release-audit/first-run.mjs` after building the Windows directory. Evidence goes to ignored `.release-local` and `artifacts-public`. The API observer covers the main Node context, not every Chromium or worker internals; netlog, process observation and source/import review provide complementary coverage. PID socket polling can miss short-lived connections, and Windows UDP endpoint tables do not identify every datagram destination. API canaries, Chromium netlog and the held-child canary address those limitations for this bounded startup/navigation audit. This is not a guarantee about every future action, configured integration, network or system proxy.
