# MoMo Community Preview 0.1

MoMo is a Windows-first personal AI operating environment. Its Executive and specialist roles reason about work while native code controls credentials, permissions and action authority.

The preview includes Dashboard, Mo/Work, Inbox, Planner, Situation and Settings, plus experimental Relay/Voice, Home Automation and Desktop Observation. Users configure their own providers and optional integrations. It starts without accounts, saved places, device mappings, schedules or conversations.

Windows x64 and the documented native build toolchain are required. Provider/model availability, SMS readiness and local device protocol coverage vary. This preview is intended to be unsigned; Windows may warn about an unknown publisher. SHA-256 checksums will accompany an approved release artifact.

Read [provider setup](PROVIDER_SETUP.md), [feature limitations](FEATURE_STATUS.md) and [security model](SECURITY_MODEL.md). No release is published until the [release gate](../PUBLIC_RELEASE_GATE.md) passes and the owner explicitly approves publication.

Opening Situation View can request its unauthenticated OpenFreeMap basemap before account setup. Chromium also follows Windows proxy/DNS settings. The [bounded first-run audit](NETWORK_AUDIT.md) documents these observations; no owner credentials or infrastructure are supplied. [Current screenshots](SCREENSHOTS.md) use isolated, explicitly synthetic examples.

The current binary remains blocked by the [MSVC helper-runtime licensing item](RUNTIME_REDISTRIBUTION.md). Electron notices and FFmpeg corresponding source are retained in the local ZIP.
