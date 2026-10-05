# Feature status

All modules are preview quality; no component is claimed production-stable merely because it worked in development.

| Module | Status | Scope and limitations |
| --- | --- | --- |
| Dashboard / Settings | Beta | Desktop workspace, local state and configuration. Fresh accounts show honest empty states. |
| Mo / Work | Beta | Native-bounded reasoning, proposals and specialist work; provider setup and model access required. |
| Responsibilities / proactive work | Experimental | Explicit grants, bounded work and opt-in schedules; no inherited schedules. |
| Inbox / Planner | Beta | User-owned Google OAuth configuration; separate consent for additional capabilities. |
| Situation | Beta | Explicit places, maps/weather, optional traffic and flight services; third-party coverage/terms apply. |
| Relay | Experimental | Separately hosted gateway and Twilio setup; SMS readiness and carrier restrictions apply. |
| Voice | Experimental | Opt-in gateway, caller/PIN policy and paired desktop required. |
| Home Automation | Experimental | Limited documented Govee LAN lighting support. Hue diagnostics only; no Hue control or Alexa integration claim. |
| Desktop Observation | Experimental | Windows helper and explicit session/target permission; disabled initially. |

Windows x64 is the intended platform. macOS/Linux packages are not validated. The application version remains `0.7.1`; Community Preview 0.1 is the release label, not a database/schema migration.

Any produced preview binary is unsigned unless the release gate explicitly records signing. Windows may display a publisher/SmartScreen warning. Verify SHA-256 and source provenance; do not disable Windows security globally.

See [PUBLIC_RELEASE_GATE.md](../PUBLIC_RELEASE_GATE.md) for outstanding validation. No live provider/device test or production security certification is implied by offline unit tests.
