# Runtime redistribution review

The exact component matrix and evidence are in [RUNTIME_REDISTRIBUTION.md](RUNTIME_REDISTRIBUTION.md). The Windows package preserves Electron's complete upstream notices and includes FFmpeg corresponding source, build/replacement instructions, separate MoMo MIT terms, and applicable Microsoft SDK/STL notices. Foreign-platform SQLite prebuilds are excluded from the x64 artifact.

**One blocking issue remains:** redistribution entitlement for proprietary MSVC v142 runtime objects linked into the two native helpers is not established by the installed standalone 2019 Build Tools license. The owner confirmed standalone Build Tools only / uncertain licensing. The dependency-license gate and overall release gate remain **FAIL**. Do not publish the binaries until that grant is established or an authorized, validated replacement build resolves it.

The 175 runtime/bundled npm records have identified licenses and retained notices. Development-only records stay in the private audit. Aggregate Chromium notice keywords were not used as a substitute for component review.
