# Runtime redistribution review

**PASS.** The former MSVC helper-runtime blocker is resolved by rebuilding both project helpers with pinned LLVM-MinGW 20260922. The build uses open-source C++/compiler and MinGW runtime code, and imports the UCRT supplied by Windows 10/11. No Visual Studio installation or MSVC runtime redistribution entitlement is needed for this build path.

The [exact component matrix](RUNTIME_REDISTRIBUTION.md) and [native build provenance](NATIVE_BUILD.md) distinguish physically shipped code from Windows imports. LLVM/MinGW grants, source-specific notices and the two Wine-derived API declaration headers accompany the Windows package. Complete MIT helper source and standalone build scripts are included. Electron's complete notices, FFmpeg corresponding source and SDK terms for the unchanged D3D compiler remain intact. Foreign-platform SQLite binaries remain excluded.

The 175 runtime/bundled npm records have identified licenses and retained notices. Development-only records stay in the private audit. Actual binaries, link inputs and source grants were reviewed; aggregate notice keywords alone were not treated as evidence of linked restricted code.
