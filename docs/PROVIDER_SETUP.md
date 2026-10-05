# Provider setup

Start in Settings. Configure only capabilities you intend to use. There are no shared community keys. The desktop does not automatically consume `.env` files. Removing a local credential does not revoke it at its provider.

| Integration | Current use | Setup and storage | Disable/remove |
| --- | --- | --- | --- |
| DeepSeek | Default Executive/generation adapter (`deepseek-flash`) | Obtain your own key at [DeepSeek](https://platform.deepseek.com/); import or enter it in Settings. Native protected storage. | Disable AI use and remove the key in Settings. |
| OpenAI | Alternate Executive (`gpt-6-luna`) and explicit access test | Use your own [OpenAI API account](https://platform.openai.com/); model access depends on that account. Native protected storage. | Select another provider or disable AI; remove the local key. |
| TypeSafe / Jev | Bounded advisory/classification roles | Obtain account access from [TypeSafe](https://typesafe.ai/). Configure Jev in Settings. Native protected storage. | Disable Jev and remove its key. |
| Google | Inbox and Calendar, scoped actions | Create your own Desktop OAuth client in [Google Cloud](https://console.cloud.google.com/). Configure the consent screen and needed Gmail/Calendar APIs, download its client JSON, import through Settings, then connect your account. Additional action scopes require consent. Client and tokens use native protected storage. | Disconnect in Settings; revoke access in your Google account if desired. |
| Open-Meteo / GeoNames | Place lookup and weather | No account key; select a place explicitly. Review [service terms](https://open-meteo.com/en/terms) for your use. | Remove saved places or disable Situation/weather. |
| OpenFreeMap | Anonymous map tiles | No private account. Loading a map contacts the tile service; see [provider information](https://openfreemap.org/). Attribution remains visible. | Disable maps in Situation. |
| TomTom | Optional routes and traffic | Supply your own [TomTom](https://developer.tomtom.com/) key in Situation settings. Native protected storage; access and data-use conditions depend on your plan. | Remove the key and disable traffic. |
| Aircraft services / FlightAware | Optional flight information | Anonymous aircraft adapters and optional [FlightAware AeroAPI](https://www.flightaware.com/aeroapi/) credentials are represented in source. Coverage and use terms vary. Configure intentionally in Situation. | Remove tracked flights/credentials and disable flights. |
| Logo.dev | Optional airline images | Configure your own **publishable** token. It appears in image URLs; never use a secret credential here. See [Logo.dev](https://www.logo.dev/). | Remove the token or disable carrier branding. |
| Govee LAN | Local documented lighting operations | Select your network interface, discover and map your own supported device, and approve operations. No cloud developer key is supplied. | Remove mapping and permissions; clear interface selection. |
| Philips Hue | Bounded network/TLS diagnostics | Enter your own bridge address only if desired. This preview does not implement Hue pairing/control. | Clear the address. |

These identifiers describe the source adapters, not a promise of access, pricing, availability or endorsement. MiniMax remains a reserved credential/status identity without an enabled public integration.

## Optional Relay and Voice

`cloud/mo-relay` contains the separate gateway. Install with `npm --prefix cloud/mo-relay ci`, validate with `npm run test:relay`, and operate it on infrastructure you control. No deployment is performed by ordinary desktop startup.

The server requires `PUBLIC_ORIGIN`, `TWILIO_ACCOUNT_SID`, `TWILIO_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_AUTH_TOKEN`, `PAIRING_TOKEN`, `PAIRING_EXPIRES_AT` and `ALLOWED_SENDERS`. Supply values through your hosting platform's secret manager; do not commit them. Twilio account and messaging eligibility are prerequisites. Desktop Relay setup uses its native secure-entry helper and protected vault. Review `admin.mjs` for pairing administration.

Voice is disabled unless `VOICE_ENABLED=true` and the remaining voice requirements are configured. `VOICE_OWNER_PHONE` and `VOICE_PIN_VERIFIER` belong to your deployment. Generate a verifier with the supplied `voice-pin.mjs` workflow; never publish a PIN or verifier. Do not enable Voice until gateway transport, caller policy and desktop readiness are understood. Disable it at the gateway and disconnect desktop Relay to stop the integration.
