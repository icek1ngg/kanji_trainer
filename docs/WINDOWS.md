# Windows desktop setup and packaging

[Back to README](../README.md)

## Install and run

Build the NSIS installer or obtain one from a published release. Run
`Kanji Trainer_<version>_x64-setup.exe` and follow its prompts. Setup uses the current
Windows account and provides Desktop and Start Menu shortcuts. The default location is:

```text
%LOCALAPPDATA%\Kanji Trainer\kanji-trainer.exe
```

The installed app needs no Node.js, npm, Rust, browser window, or local server.
It uses Microsoft WebView2. Setup includes Microsoft's offline runtime installer,
which increases the package size but avoids downloading the runtime during setup.
The standalone EXE also needs WebView2; use the installer for normal use.

Builds are unsigned and have no automatic updater. Windows may display a publisher
or reputation warning. Do not disable security features to run the application.

## Build prerequisites

Use Windows x64 with:

- Node.js 22.12+ or 24+ and npm.
- Git.
- Stable Rust through rustup, targeting `x86_64-pc-windows-msvc`.
- Visual Studio 2022 Build Tools, Desktop development with C++ workload, and Windows SDK.
- Microsoft Edge WebView2 Runtime.

Check existing installations before installing anything. For missing C++ or Rust
tools, these commands use official package sources through winget:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --source winget --accept-source-agreements --accept-package-agreements --silent --override '--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
winget install --id Rustlang.Rustup --exact --source winget --accept-source-agreements --accept-package-agreements --silent --override '-y --default-host x86_64-pc-windows-msvc --default-toolchain stable --profile minimal'
```

Microsoft's installer may require UAC approval or a restart. Complete those actions
when requested. Do not reinstall working tools or bypass administrator permissions.

## Develop and build

From the repository root:

```powershell
npm ci
npm run desktop:info
npm run desktop:dev
```

For production:

```powershell
npm run test:unit
npx playwright install chromium
npm test
npm run build
npm run desktop:build
```

`npm run tauri build` also builds the desktop application. `scripts/tauri.mjs` adds
Cargo to its child process PATH and loads the detected Visual C++ environment.
It does not change machine PATH, registry, execution policy, or security settings.
Keep `package-lock.json` and `src-tauri/Cargo.lock` in Git.

The first build downloads Rust crates, NSIS tooling, and the offline WebView2
installer. Running the installed app does not require those downloads.

| Output | Location |
| --- | --- |
| Application EXE | `src-tauri/target/release/kanji-trainer.exe` |
| NSIS setup EXE | `src-tauri/target/release/bundle/nsis/` |

Do not commit build directories or installers. Publish the setup EXE through GitHub
Releases. The verified 1.0.0 installer is approximately 210 MiB, exceeding GitHub's
regular Git file-size limit.

## Configuration and security

`src-tauri/tauri.conf.json` defines metadata and bundles `dist/`. The window starts
centered at 1200 × 800, is resizable, and has a minimum size of 800 × 600. Hash
routing and relative asset paths work from Tauri's local origin.

Keep **`com.kanjitrainer.desktop`** stable after distribution. Changing the identifier
can change the application data location. Coordinate version changes across
`package.json`, `src-tauri/Cargo.toml`, and the Tauri configuration.

Production CSP permits local assets and Tauri IPC. Vite loopback/WebSocket access
is limited to the development CSP. Native capabilities allow the Save dialog and
file writes; the dialog grants access to the selected path. No broad home-directory
write permission is requested. Cancellation writes nothing and reports no success.
Browser exports retain ordinary browser downloads.

## Persistent data and browser migration

IndexedDB and preferences remain in the application's WebView2 profile. The
database remains `kanji-trainer`, schema version 2. Packaging does not reset or
seed it. Browser data uses a separate profile and origin.

To transfer browser data:

1. Open the original browser app at its usual local address.
2. Under **Cài đặt**, select **Xuất bản sao lưu** and save the JSON file.
3. Open the desktop app and select that JSON file under **Cài đặt**.
4. Review the preview and confirm **Khôi phục bản sao lưu**.

Restore replaces destination data after confirmation. JSON includes the library,
history, sessions, preferences, and theme. Excel/CSV transfers the library only,
with exactly `Kanji` and `Âm Hán Việt` columns.

Keep personal backups outside Git. Backups are unencrypted and contain submitted
answers. Save JSON backups before changing machines or removing application data.

## Verification

After building:

```powershell
npm run desktop:test
# Or test an installed executable:
node scripts/desktop-smoke.mjs --exe "$env:LOCALAPPDATA\Kanji Trainer\kanji-trainer.exe"
```

The runner starts the real EXE and connects to WebView2 through CDP. It uses a unique
profile in `test-results/desktop-smoke/`, never the normal user profile, and starts
no development server. Debugging arguments apply only to the test child process.
Reports and screenshots are excluded from Git.

The most recent implementation verification passed:

- 162 unit tests and 53 browser tests.
- Frontend and Windows production builds.
- 35 checks on each standalone and installed EXE: all three practice modes,
  all-reading validation, CSV import, statistics, JSON restore, theme, refresh
  persistence, and persistence after terminating/restarting the executable.
- No external requests, console errors, or JavaScript page errors in those runs.
- NSIS installation with exit code 0 and creation of both shortcut types.

Native Save-dialog interaction still needs an interactive check. Unit tests cover
cancellation, Unicode/byte handling, and write failures; browser tests cover Excel
and JSON downloads. Installation on a clean machine without WebView2 has not been
verified separately.

## References

- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Windows installers](https://v2.tauri.app/distribute/windows-installer/)
- [Content Security Policy](https://v2.tauri.app/security/csp/)
- [Playwright WebView2 testing](https://playwright.dev/docs/webview2)
