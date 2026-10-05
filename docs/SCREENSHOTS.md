# Current public screenshots

All nine images were freshly captured from the current Community Preview 0.1 package at **1920×1080**, then individually visually reviewed. The current renderer/assets match the public build derived from the latest recorded private baseline; no old prototype or rejected duplicate capture is reused. No production UI code changed for these images.

| Capture | State and provenance |
| --- | --- |
| [Dashboard](screenshots/dashboard.png) | Empty account/task profile; fictional Relay attention item |
| [Mo](screenshots/mo.png) | Current Mo pane, provider unconfigured; same demo Dashboard |
| [Work](screenshots/work.png) | Distinct Work pane, no active work or approvals |
| [Inbox](screenshots/inbox.png) | Honest Google-not-connected setup state |
| [Planner](screenshots/planner.png) | Honest Google-not-connected setup state |
| [Situation View](screenshots/situation.png) | Public Paris city example; no owner place, route or clock; traffic/flights off; map attribution visible |
| [Relay](screenshots/relay.png) | Explicit synthetic held message from fictional Demo-studio; no phone, Twilio SID, carrier delivery or private endpoint |
| [Home Automation](screenshots/home.png) | Simulated mapped H6000 light named Demo studio light; no live discovery, command, device identity or owner mapping |
| [Settings](screenshots/settings.png) | Unconfigured public profile with UTC documentation preference |

The documentation-only [capture harness](../scripts/release-audit/capture-screenshots.mjs) replaces Home, Relay and Situation IPC responses only inside its disposable process. The fictional Relay receipt also appears as a Dashboard attention item. Account credentials and tasks remain empty. Synthetic data is never seeded into normal startup, and this harness is outside the package allowlist.

Navigation waits for sidebar readiness and asserts the active workspace route, topbar heading, pane mode and module-specific visible elements before capture. It waits for fonts and checks PNG dimensions; all nine SHA-256 values must differ. [manifest.json](screenshots/manifest.json) records module, actual route, visible headings, pane, viewport, hashes, renderer/main fingerprints and provenance. Mo and Work deliberately share the Dashboard route but have different asserted pane modes.

Review checked correct module, distinct content, readable controls, full viewport, map attribution, and absence of owner identity, paths, credentials, private clocks, actual device IDs, DevTools and debug overlays. All images pass. These are documentation examples, not claims of a connected account or live service operation.
