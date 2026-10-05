# FFmpeg corresponding source — Electron 44.4.3 Windows x64

This software uses FFmpeg under LGPL 2.1 or later. The complete Chromium FFmpeg source snapshot is supplied beside this file, rather than a promise to supply it later. Preserve this directory with every Windows ZIP.

* Archive: `chromium-ffmpeg-2b68d2babae73714846961fb0ee47e3b3d2e39a9.tar.gz`
* SHA-256: `22b99670662430f77f1bb03408b99657a958b5e899c19b94f3571a03308c43c4`
* Source revision: `2b68d2babae73714846961fb0ee47e3b3d2e39a9`; upstream merge `a5e6c0175a7245fc1a9f4639da2810156128aa8b`. Upstream `RELEASE` says `8.0.git`; this is a pinned Chromium fork, not an unmodified numbered FFmpeg release.
* Downloaded from the [Chromium source archive](https://chromium.googlesource.com/chromium/third_party/ffmpeg/+archive/2b68d2babae73714846961fb0ee47e3b3d2e39a9.tar.gz).
* Electron's entire additional FFmpeg patch is `electron-44.4.3.patch`. It changes a macOS install-name branch only; it is included for exact source provenance. MoMo makes no FFmpeg changes.

The archive includes FFmpeg source, licenses, Chromium modifications, `BUILD.gn`, `ffmpeg_generated.gni`, build scripts, and generated platform configuration headers. In `chromium/config/Chrome/win/x64/config.h`, `CONFIG_GPL`, `CONFIG_NONFREE`, and `CONFIG_VERSION3` are all zero. The configuration enables AAC/H.264 and other decoders. These codec flags do not enable GPL code and do not confer patent rights.

## Rebuilding a compatible DLL

Use the [Electron 44.4.3 source/build workflow](https://github.com/electron/electron/blob/v44.4.3/docs/development/build-instructions-gn.md) on a Windows x64 build host. Checkout tag `v44.4.3`, synchronize its pinned DEPS and apply its patches. The Electron DEPS pins Chromium `152.0.7977.130`; Chromium pins the FFmpeg revision above. The source and sole FFmpeg patch here allow that component to be inspected and changed locally.

From that synchronized Chromium `src` directory:

```powershell
gn gen out/Release --args='import("//electron/build/args/release.gn") target_cpu="x64"'
autoninja -C out/Release third_party/ffmpeg:ffmpeg
```

The release arguments import `all.gn`: `ffmpeg_branding="Chrome"`, `proprietary_codecs=true`, `is_component_build=false`, `is_component_ffmpeg=true`. A corresponding Electron build environment is needed; the MoMo MSVC helper toolchain alone does not build Chromium. The supplied GN/configuration files are the upstream build inputs, not a claim of a locally reproduced Electron binary.

Close MoMo, keep a backup, then replace the adjacent `ffmpeg.dll` with your ABI-compatible modified DLL. The DLL is dynamically linked, outside ASAR; MoMo imposes no DLL signature/hash lock. You may modify the LGPL library and reverse engineer the combined work for debugging those modifications. Microsoft component terms do not restrict these FFmpeg rights. MoMo's source is also supplied under MIT. No relinking object files or written three-year source offer is substituted for the included library source.

Upstream evidence: [Electron DEPS](https://github.com/electron/electron/blob/v44.4.3/DEPS), [Chromium DEPS](https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/DEPS), [release arguments](https://github.com/electron/electron/blob/v44.4.3/build/args/release.gn), [all arguments](https://github.com/electron/electron/blob/v44.4.3/build/args/all.gn), [FFmpeg patch list](https://github.com/electron/electron/blob/v44.4.3/patches/ffmpeg/.patches), [FFmpeg licensing guidance](https://ffmpeg.org/legal.html).
