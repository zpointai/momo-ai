# Runtime redistribution review — unresolved

The locked npm runtime/bundled-code inventory contains 175 package records with identified license metadata and retained notice text, including notices found in upstream package READMEs. This is not a complete license clearance for an Electron executable.

The downloaded Electron 44.4.3 distribution includes `LICENSE` and `LICENSES.chromium.html`. Both are retained in the Windows package. Its Chromium notices include an FFmpeg component with LGPL terms, as well as GPL, AGPL and non-commercial wording elsewhere in the aggregate notice collection. Some entries may describe build tools, optional source or alternatives rather than code shipped in this Windows binary. Keyword counts alone cannot establish which obligations apply.

Before publication, identify the actual bundled multimedia/runtime configuration, retain the required notices, establish the corresponding-source/relinking or other applicable distribution requirements, and document how this release satisfies them. Also confirm the redistribution basis for the statically linked Microsoft C++ runtime in the project helpers. Do not relicense those third-party components as MoMo MIT code.

Publication is blocked pending this component-level review. No GPL/AGPL incompatibility or non-commercial restriction is asserted solely from the aggregate notice text, and no blanket compatibility assumption has been made.
