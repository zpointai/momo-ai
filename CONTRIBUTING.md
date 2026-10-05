# Contributing

Use the Windows toolchain and commands in the README. Keep changes focused, preserve existing behavior and include meaningful product/security regression checks. Run typecheck, lint, tests, the source security scan and a production build before proposing a change.

Desktop surfaces live in `src/desktop`, contracts in `src/shared`, authority/services in `electron`, and bounded Windows helpers in `native`. Follow the existing adaptive desktop layout and accessible interaction patterns. Screenshots must use disposable synthetic profiles or empty first-run state.

Provider and device integrations require strict schemas, bounded calls, redacted failures, cancellation and explicit authority. Never move credentials into renderer read APIs or let model output grant permissions. Explain security effects in the pull request and seek private discussion for vulnerabilities.

Public tests retain substantive product, storage, IPC, credential, policy, UI and device-protocol checks. Sealed internal evaluation suites that require private benchmark/evidence history are excluded. Synthetic helper code needed by product/security tests is retained; no live account is needed for ordinary CI.

The test configuration pins `Europe/Amsterdam` for calendar fixtures before workers start, regardless of the host timezone. This is a synthetic test convention; production defaults still follow the user's operating system. Tests allow 15 seconds in CI (5 seconds locally) for slower hosted Windows DOM interactions; the production-bundle isolation test allows 30 seconds for its three builds. Assertions and application deadline checks are unchanged.

Do not add real secrets, private user content or owner/device identifiers, including in tests. Contributions are made under the project's MIT license. Third-party material needs clear provenance and its required notices.
