# MoMo AI

**Community Preview 0.1 · Windows x64 · local release candidate**

The local release gates have passed. This is an unsigned Community Preview for Windows 10/11 x64; see [validation and release limits](PUBLIC_RELEASE_GATE.md).

MoMo AI is a Windows-first personal AI operating environment. Models reason and propose work; native code owns credentials, permissions, tools and action authority.

## Why MoMo?

One owner-facing Mo Executive coordinates bounded specialist roles across conversations, Work, responsibilities, Inbox, Planner, Situation and optional integrations. Models cannot grant themselves permissions. Native policy validates proposed actions against explicit grants, approval state, request budgets and cancellation. Consequential actions require owner approval.

The desktop includes proactive work, remote Relay/Voice and local Home Automation source. These capabilities require deliberate setup and retain their existing authority boundaries. This is the genuine technical project, with private development history and user data excluded.

```mermaid
flowchart TD
  Owner[Owner] --> UI[Mo desktop]
  UI --> Executive[Mo Executive: model reasoning]
  Executive --> Specialists[Bounded specialist roles]
  Specialists --> Native[Native runtime: action authority]
  Owner -->|Explicit grants and approvals| Native
  Native --> Google[Google: Inbox and Calendar]
  Native --> Work[Local tasks, Work and responsibilities]
  Native --> Situation[Situation services]
  Native --> Relay[Optional Relay and Voice gateway]
  Native --> Home[Local Home Automation]
  Native --> Observation[Opt-in Desktop Observation]
```

## Developer quick start

Requirements: Windows 10/11 x64, Node.js 24 or newer and npm. `setup:native` downloads a pinned, checksum-verified LLVM-MinGW toolchain into the checkout. The supported build needs no Visual Studio, Microsoft Build Tools, Windows SDK installation or Python. See [native build and licenses](docs/NATIVE_BUILD.md).

From a checkout of this repository:

```powershell
npm ci
npm run setup:dependencies
npm run setup:native
npm run typecheck
npm run lint
npm test
npm run security:scan
npm run dev
```

Open Settings and configure your own provider. No provider key, Google account, location, device, conversation or schedule is supplied. Credentials normally enter through Settings; `.env.example` documents configuration names and is not loaded automatically by the desktop.

```powershell
npm run build
npm run package:win:dir
```

Dependency lifecycle scripts are disabled by `.npmrc`; `setup:dependencies` runs only the reviewed Electron/esbuild binary installers. SQLite 13 supplies a Node-API prebuild used by Node and Electron. The preview uses `%APPDATA%\MoMo-community-preview` (development: `MoMo-community-preview-development`) and does not migrate an existing MoMo profile.

## Read more

![Current Dashboard with a fictional Relay attention item](docs/screenshots/dashboard.png)

Fresh 1920×1080 captures from the current public build. The Relay item and Home light are documentation-only simulations; no account or device is connected.

| Relay: synthetic held message | Home: simulated mapped light |
| --- | --- |
| ![Synthetic Relay](docs/screenshots/relay.png) | ![Simulated Home light](docs/screenshots/home.png) |

[All nine screenshots and provenance](docs/SCREENSHOTS.md) · [First-run network audit](docs/NETWORK_AUDIT.md) · [Runtime redistribution](docs/RUNTIME_REDISTRIBUTION.md)

- [Architecture](docs/ARCHITECTURE.md) and [security model](docs/SECURITY_MODEL.md)
- [Provider and optional integration setup](docs/PROVIDER_SETUP.md)
- [Feature status and limitations](docs/FEATURE_STATUS.md)
- [Contributing](CONTRIBUTING.md), [roadmap](docs/ROADMAP.md), and [security reporting](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md) and [asset provenance](docs/ASSETS.md)

MoMo is an independent project. Provider compatibility does not imply affiliation, sponsorship or endorsement. Third-party names and trademarks belong to their respective owners.

Source and confirmed project-owned artwork are [MIT licensed](LICENSE). Third-party dependencies and fonts retain their own licenses. Internal application version `0.7.1` is retained; the proposed public release tag is `community-preview-0.1`.
