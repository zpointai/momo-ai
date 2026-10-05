# Architecture

The active application starts at `src/main.tsx`, rendering the React desktop in `src/desktop`. Typed contracts and strict schemas live in `src/shared`. `electron/main.ts` assembles native services and exposes narrow validated IPC operations through the preload bridge. The old web prototype is not part of this distribution.

Models return bounded content or proposals. The Executive delegates through native Work machinery, where policy, account scope, source revisions, grants, approval status, request accounting and cancellation remain authoritative. A model's output cannot change those controls.

`electron/storage` owns SQLite through a worker. `electron/credentials`, `electron/google/vault.ts` and `electron/relay/vault.ts` own protected secret storage. Native service layers cover AI, Google, mail, calendar actions, Situation, Home Automation, Relay and Desktop Observation. Stored conversations, tasks, permissions and integration state are created only by user activity.

The renderer is sandboxed with context isolation and no Node integration. Its network allowlist admits the application origin, the anonymous basemap, and validated publishable logo URLs. Provider API traffic runs natively. Build-time graph checks reject privileged and retired web imports in the renderer.

Two Windows C++ helpers implement bounded desktop observation and secure Relay setup. They are built from source, shipped as fixed resources outside ASAR and verified against build identities. Do not replace them with binaries copied from another installation.

The optional `cloud/mo-relay` Node service is a separate trust boundary and deployment. It requires the user's own configuration; no hosted relay is supplied. Desktop use does not require deploying it.

Build output contains bundled renderer, main, preload and storage worker code. The package allowlist excludes tests, audit tools, profiles, source maps and private evidence. Dependency install directories and generated output are never exported from the private project.
