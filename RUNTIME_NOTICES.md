# Windows runtime notices and terms

MoMo's source and project-owned artwork are MIT licensed. In this Windows distribution, `LICENSE.MoMo.txt` contains that grant. The root `LICENSE.electron.txt` is Electron's license. Other components retain their own terms; MoMo does not claim their ownership or relicense them under MIT.

Electron 44.4.3 is MIT licensed. Preserve its root `LICENSE.electron.txt` and complete `LICENSES.chromium.html`, which include the bundled Chromium, Node.js, graphics, multimedia and other third-party notices. npm and font notices are inside `resources/app.asar/licenses` in the packaged application and under `licenses` in the source checkout. `THIRD_PARTY_NOTICES.md` lists the bundled npm code. `RUNTIME_REDISTRIBUTION.md` identifies the native files.

This software uses libraries from the FFmpeg project under LGPL 2.1 or later. Full corresponding library source, license, Electron patch and build/replacement instructions accompany the binary under `resources/third-party-source/ffmpeg`. In a source checkout they are under `vendor/ffmpeg`. Recipients may replace the dynamically linked `ffmpeg.dll` with an ABI-compatible modified version, modify the library, and reverse engineer for debugging those modifications. No term here limits rights granted by an open-source component's license. A binary download must retain the included source directory; a separate website download page must identify FFmpeg and link to the accompanying source.

## Microsoft components

The unchanged `d3dcompiler_47.dll` is Windows SDK distributable code, supplied only as part of this classic Windows application. Windows system DLLs imported by those files are supplied by Windows and are not redistributed here. No MSVC debug runtime, standalone `.lib`, MSVC runtime DLL or redistributable installer is included.

Use and redistribution of the Microsoft SDK components are subject to the Microsoft terms in `licenses/microsoft/WINDOWS-SDK-LICENSE.txt` and the accompanying `WINDOWS-SDK-REDIST.txt`. By using or redistributing those components, you agree to those applicable terms. Distributors must preserve their notices and terms and require downstream recipients to agree to terms that protect those Microsoft components to the extent required by the SDK agreement. These requirements apply to the Microsoft components, not to MoMo's MIT source or to the LGPL FFmpeg library. Do not distribute those Microsoft components as standalone products, for non-Windows platforms, or as if Microsoft endorses MoMo.

`dxcompiler.dll` and the open-sourced DXIL validator retain their LLVM/NCSA and component notices in `LICENSES.chromium.html`. Their presence is not a claim that all Microsoft components share one license.

## Native helpers

The project helpers use LLVM-MinGW 20260922: LLVM 23.1.2 C++/compiler runtimes and MinGW-w64 startup/support code, with Windows-provided UCRT imports. Their applicable Apache-2.0 WITH LLVM-exception, ZPL-2.1, public-domain, gdtoa and other permissive notices are retained under `licenses/llvm-mingw`. No proprietary MSVC runtime object code is linked into these helpers.

Wine-derived API declaration headers are under LGPL 2.1 or later; their original notices, exact source and license are under `resources/third-party-source/mingw-w64`. Complete project helper sources and standalone build recipes accompany them in `resources/third-party-source/native-helpers`. Recipients may modify, rebuild and debug these components. To integrate modified helpers, rebuild the MIT desktop source to refresh its security identity pins.

Codec support and source-code licenses do not grant third-party patent or trademark rights. Provider services, accounts and data have separate terms.
