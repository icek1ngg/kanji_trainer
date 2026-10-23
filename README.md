# Kanji Trainer

A local, offline Kanji practice app with a Vietnamese interface. Built with React
and JavaScript, Vite, IndexedDB, and Tauri 2 for Windows.

## Features

- Manage, search, edit, and bulk-delete Kanji and their Sino-Vietnamese readings.
- Import/export Excel and CSV with preview and duplicate handling.
- Practice in a table or with Flashcards, with saved drafts and resumable sessions.
- Manually retry wrong answers and browse recorded practice history.
- View actual practice totals, accuracy, difficult Kanji, and activity charts.
- Choose light/dark appearance, default practice size, and feedback preferences.
- Export and restore full JSON backups, with confirmation before replacement or resets.
- Run as a browser app or Windows desktop application.

No backend, account, cloud database, spaced repetition, or scheduled reviews are
used. Data stays on the device. Install dependencies and build tools before offline use.

## Quick start: browser app

Requires Node.js **22.12+ or 24+** and npm.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. For a production build:

```sh
npm run build
npm run preview
```

Use the URL printed by the preview server. The browser edition needs a running
local server even without internet. There is no service worker or installable PWA;
opening `dist/index.html` directly is unsupported.

## Windows desktop app

The desktop application embeds the frontend and runs without Node, a browser
window, or a development server. Microsoft WebView2 is required at runtime. The
NSIS installer includes the offline WebView2 installer for machines without it.

For Windows development, install stable Rust with the MSVC target, Visual Studio
Build Tools with the C++ workload, and Windows SDK, then run:

```sh
npm ci
npm run desktop:info
npm run desktop:dev
```

To build the executable and installer:

```sh
npm run desktop:build
```

| Output | Path |
| --- | --- |
| Application | `src-tauri/target/release/kanji-trainer.exe` |
| NSIS installer | `src-tauri/target/release/bundle/nsis/` |

See [Windows setup, packaging, and data migration](docs/WINDOWS.md).
Build outputs are excluded from Git. Attach installers to GitHub Releases rather
than committing them to the source repository.

## Reading validation

Each Kanji displays its required reading count, for example **散 · 2 âm**. An answer
must contain **all** readings, in any order. Vietnamese diacritics are significant;
case and surrounding whitespace are normalized.

For `散: TÁN/TẢN`:

| Answer | Result |
| --- | --- |
| `TÁN` | Incorrect |
| `TẢN` | Incorrect |
| `TÁN/TẢN` | Correct |
| `TẢN/TÁN` | Correct |

Separate multiple readings with `/`, `;`, or `｜`. Duplicate, missing, and additional
readings are rejected. Practice reveals stored correct readings only on request.

## Excel and CSV format

Files must contain exactly these two columns, with headers in the first row:

| Kanji | Âm Hán Việt |
| --- | --- |
| 散 | TÁN/TẢN |
| 学 | HỌC |

Reading counts are calculated by the app. Do not add count, status, meaning, or
history columns. Spreadsheets transfer the library only; JSON backups transfer
complete application data.

SheetJS 0.20.3 is supplied in `vendor/xlsx-0.20.3.tgz` and referenced by
`package.json`. **Keep this file in Git** so clean installs can resolve it.
See the [SheetJS installation guide](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/).

## Local data and backups

IndexedDB database `kanji-trainer`, schema version 2, contains `kanji`, `sessions`,
and `attempts` stores. Preferences and theme use localStorage. Additive database
upgrades preserve existing records.

Browser data belongs to its profile and origin, including hostname and port.
Use a consistent local address. Desktop WebView2 data is separate. To migrate,
export JSON from **Cài đặt** in the browser, then preview and restore it under
**Cài đặt** in the desktop app.

Restore replaces destination data after confirmation. Session reset preserves
recorded attempts and the library. History reset removes sessions and attempts
while preserving the library. Clearing site data or deleting a profile removes
local data. Keep JSON backups yourself; backups are not uploaded automatically.

Individual history begins with the implementation of attempt recording. Older
aggregate counters are preserved without inventing or double-counting past attempts.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite |
| `npm run build` | Build frontend into `dist/` |
| `npm run preview` | Serve frontend production build |
| `npm run test:unit` | Run Vitest domain and data tests |
| `npm test` | Run Playwright browser tests |
| `npm run desktop:info` | Inspect Tauri build environment |
| `npm run desktop:dev` | Start Tauri development mode |
| `npm run desktop:build` | Build Windows EXE and NSIS installer |
| `npm run tauri -- <command>` | Run another Tauri CLI command |
| `npm run desktop:test` | Test the built EXE in an isolated profile |

Before running browser tests for the first time:

```sh
npx playwright install chromium
```

The most recent implementation verification passed **162 unit tests**, **53 browser
tests**, and **35 desktop smoke checks** on each standalone and installed EXE.
Coverage includes reading validation, Excel round trips, persistence, upgrades,
backup/restore, conflicts, mobile/dark layouts, and a 1,000-record synthetic library.
Native Save-dialog interaction and installation on a clean machine without WebView2
still need separate verification.

## Project structure

```text
src/
  components/     Shared UI
  data/           IndexedDB repositories, backups, and preferences
  domain/         Validation, sessions, imports, history, and statistics
  hooks/          React data-loading hooks
  pages/          Vietnamese application screens
  platform/       Browser and native file-export adapter
src-tauri/        Rust application, Tauri config, capabilities, and icons
scripts/          Desktop environment wrapper and WebView2 smoke runner
tests/            Playwright browser tests
vendor/           Required local SheetJS package
docs/             Windows setup and packaging guide
```

Commit source, configuration, icons, `package-lock.json`, `src-tauri/Cargo.lock`,
and the vendor package. `.gitignore` excludes dependencies, generated files,
installers, reports, local backups, and environment secrets. Keep personal Kanji
exports and JSON backups outside Git.

## Limitations

- Windows builds are unsigned and have no automatic updater.
- IndexedDB and localStorage cannot share a transaction; restore reports partial
  settings-persistence failures explicitly.
- JSON backups are unencrypted and include submitted answers.
- Large-library verification covers 1,000 synthetic records, not arbitrary file sizes.
