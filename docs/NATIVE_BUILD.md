# Native helper build and redistribution

Community Preview 0.1 builds both C++ helpers with **LLVM-MinGW 20260922, LLVM 23.1.2**, targeting Windows 10/11 x64. This replaces the former MSVC build. The helper C++ behavior, protocol and permission boundaries are unchanged; the desktop identity schema now identifies the new runtime and continues checking the exact binary hash.

From the checkout, run `npm run setup:native`, then `npm run build`. The setup downloads the portable toolchain into the ignored `.release-local/toolchains` directory and verifies its archive before extraction. It does not install a system product or modify PATH. CI uses the same commands. No Microsoft Build Tools, Visual Studio, Windows SDK installation or Python is required for the supported build. Node.js 24+ is required; SQLite uses the locked Node-API prebuild.

| Input | Pin |
| --- | --- |
| Toolchain | [LLVM-MinGW 20260922 release](https://github.com/mstorsjo/llvm-mingw/releases/tag/20260922), `llvm-mingw-20260922-ucrt-x86_64.zip` |
| Archive SHA-256 | `e3ad77d117a4bea19a7a3b333341824d79a5a371004a10e25b8504e7b3047666` |
| LLVM source | `85ac560262434c9ccfc0c183ec22d4138ed647fb` |
| MinGW-w64 source | `57b595039040eaa15bece85b7cc71d952281b269` |

The build uses Clang/LLD, the toolchain's Win32 headers and import libraries, static LLVM C++/compiler runtimes, MinGW startup/support code, and **dynamic Windows UCRT imports**. It excludes ambient SDK paths, library paths and compiler flags. Build recipes have no MSVC fallback. No compiler, SDK library, UCRT DLL or other toolchain program is packaged.

Both outputs embed the original `asInvoker`, `uiAccess=false` manifest; Relay retains its native dialog resource. Release optimization, stack protection, CFG, ASLR, DEP and high-entropy addresses are enabled. The build inspects the actual PE architecture, imports, privilege resource and hardening flags. Only Windows system imports are allowed. Link maps and inspections are local audit output under `.release-local/native-build`.

Run `npm run test:native` after building. It exercises actual executables: observer COM initialization and identity, rejected observation/authorization without a grant, termination on a wrong sequence, non-pipe launch rejection, and Relay invalid-owner rejection. It never enumerates owner windows or enters credentials. An elevated/session-zero CI environment reports its restriction explicitly; the local release validation exercised a real non-elevated session successfully. `node scripts/check-desktop-observer.mjs` also checks the closed native call vocabulary.

LLVM component grants and the MinGW aggregate and exact linked-source notices are under `licenses/llvm-mingw`. The linked MinGW objects use public-domain, ZPL and permissive grants including gdtoa. Actual link-map/source review found no Cephes or GPL runtime implementation. Two used Wine-derived headers contain API declarations under LGPL 2.1 or later; their exact source and license are supplied under `vendor/mingw-w64`. No Wine implementation library is linked. Do not infer runtime licensing from unused tools or alternative components mentioned in aggregate notices.

The Windows package includes those declarations and complete MIT helper sources/build recipes under `resources/third-party-source`. Its native-source README explains rebuilding without npm dependencies. Modified helpers can be integrated by rebuilding the full MIT application, which refreshes the security identity pins. There is no restriction on modifying, relinking or debugging these components.

The prior standalone Microsoft Build Tools redistribution uncertainty no longer applies to these helper binaries. Electron's unchanged D3D compiler remains a separately licensed SDK component with its applicable redistribution terms retained. See the [full runtime matrix](RUNTIME_REDISTRIBUTION.md).
