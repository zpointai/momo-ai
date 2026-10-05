# Security model

This is a preview, not a formally certified security boundary. Independent review is welcome.

The native runtime stores AI, Google and Relay credentials through Electron `safeStorage`. On Windows this uses OS-backed protection; storage fails closed when protection is unavailable. This protects stored bytes, not a compromised Windows account or operating system. Local databases and other user content are not all encrypted.

Settings supports bounded write-only key entry and native file import where implemented. A typed key necessarily exists briefly in the input UI; the native runtime does not return saved plaintext provider credentials to the renderer. Snapshots expose configuration status. The publishable logo token is an explicit exception: it is used in validated image URLs and must not be a provider secret.

Native IPC checks trusted senders and strict input/output contracts. Renderer sandboxing, context isolation, content security policy and request allowlists restrict execution and network access. Model prompts receive selected task evidence, not unrelated provider credentials. External content is evidence and cannot grant authority.

Work proposals remain subject to native policy, explicit grants, freshness, approval, bounded budgets and cancellation. Models cannot expand tools or permission levels. Background intelligence is off by default. Desktop Observation requires permission and per-session target approval; its helper excludes broad desktop traversal and action injection. Helper verification remains enabled.

Home starts with no interface selection, mapped device, Hue address or remembered permission. Discovery and device operations require explicit configuration. Protocol and identity validation remain active; synthetic LAN fixtures never contact devices.

Relay/Voice cross a separately operated gateway boundary. Pairing, gateway credentials, sender policy and voice verification belong to the deploying user. Voice is opt-in. Desktop-only use requires no gateway, phone number or cloud account.

The Community Preview uses a distinct user-data directory. It does not copy another installation's profile. Tests and documentation captures use disposable profiles. Never include real secrets, email, device identities, profiles, logs or provider response bodies in public issues or pull requests.

Secret scans are defense in depth, not proof that every possible credential format is covered. Publication additionally requires manual review, history review, first-run observation and package inspection.
