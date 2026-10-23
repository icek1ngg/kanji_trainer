/*
 * Production desktop smoke test for the compiled Tauri executable.
 *
 * WebView2 exposes a localhost CDP endpoint when
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS contains a remote-debugging port.
 * Playwright's documented connectOverCDP flow is used here instead of
 * launching a browser or starting a web server. The application process is
 * the only backend involved in this test.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUN_ID = randomUUID();
const REPORT_DIR = path.join(ROOT, 'test-results', 'desktop-smoke', RUN_ID);
const PROFILE_DIR = path.join(REPORT_DIR, 'profile');
const DEFAULT_EXE = path.join(ROOT, 'src-tauri', 'target', 'release', 'kanji-trainer.exe');
const WAIT_MS = 35_000;
const ALLOWED_HOSTS = new Set(['tauri.localhost', 'ipc.localhost']);
const ALLOWED_PROTOCOLS = new Set(['tauri:', 'asset:', 'ipc:', 'about:']);

const report = {
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  outcome: 'failed',
  executable: null,
  profileDirectory: PROFILE_DIR,
  launches: [],
  screenshots: [],
  assertions: [],
  consoleErrors: [],
  pageErrors: [],
  externalRequests: [],
  nativeFilePicker: {
    status: 'not-automated',
    note: 'Native save dialogs cannot be automated through CDP. Excel and JSON export picker behavior requires manual verification.',
  },
  error: null,
};

function parseExecutable(argv) {
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--exe') return argv[index + 1] || DEFAULT_EXE;
    if (argument.startsWith('--exe=')) return argument.slice('--exe='.length) || DEFAULT_EXE;
  }
  return process.env.KANJI_DESKTOP_EXE || DEFAULT_EXE;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  if (!port) throw new Error('Could not allocate a localhost debugging port.');
  return port;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForCdp(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + WAIT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`WebView2 CDP endpoint did not become available at ${endpoint}: ${lastError?.message || 'timeout'}`);
}

function attachProcessExit(child) {
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  child.once('exit', (code, signal) => resolveExit({ code, signal }));
  return exited;
}

async function launchDesktop(executable) {
  const port = await freePort();
  const browserArguments = [
    process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS?.trim(),
    `--remote-debugging-port=${port}`,
  ].filter(Boolean).join(' ');
  const child = spawn(executable, [], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // This folder is unique to the smoke run and is reused by the second
      // launch. The installed app's normal WebView2 data directory is never
      // read or changed.
      WEBVIEW2_USER_DATA_FOLDER: PROFILE_DIR,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments,
    },
  });
  const exited = attachProcessExit(child);
  const stdout = [];
  const stderr = [];
  child.stdout?.on('data', chunk => stdout.push(String(chunk)));
  child.stderr?.on('data', chunk => stderr.push(String(chunk)));
  child.once('error', error => stderr.push(String(error?.stack || error)));

  const browser = await waitForCdp(port).catch(async error => {
    child.kill();
    await Promise.race([exited, delay(2_000)]);
    const nativeOutput = [...stdout, ...stderr].join('').trim();
    throw new Error(`${error.message}${nativeOutput ? `\n${nativeOutput}` : ''}`);
  });
  report.launches.push({
    port,
    pid: child.pid,
    profileDirectory: PROFILE_DIR,
    startedAt: new Date().toISOString(),
  });
  return { child, browser, exited };
}

async function stopDesktop({ child, browser, exited }) {
  try { await browser?.close(); } catch { /* CDP may already be disconnected during shutdown. */ }
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill();
  const result = await Promise.race([exited, delay(5_000).then(() => null)]);
  if (result || child.exitCode !== null) return;
  // The fallback targets only the exact process that this script spawned.
  // It is needed for a WebView2 child tree that keeps the parent alive after a
  // normal kill request; no broad process matching is used.
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'taskkill', '/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise(resolve => killer.once('exit', resolve));
    await Promise.race([exited, delay(2_000)]);
  }
}

async function instrumentContext(context) {
  await context.route('**/*', async route => {
    let url;
    try { url = new URL(route.request().url()); } catch {
      await route.continue();
      return;
    }
    if (ALLOWED_PROTOCOLS.has(url.protocol) || ALLOWED_HOSTS.has(url.hostname)) {
      await route.continue();
      return;
    }
    report.externalRequests.push({ url: url.href, method: route.request().method() });
    await route.abort();
  }).catch(error => {
    report.externalRequests.push({ error: `Could not install request guard: ${error.message}` });
  });

  const addPageListeners = page => {
    page.on('console', message => {
      if (message.type() !== 'error') return;
      report.consoleErrors.push({ url: page.url(), text: message.text() });
    });
    page.on('pageerror', error => {
      report.pageErrors.push({ url: page.url(), text: error?.stack || error?.message || String(error) });
    });
  };
  for (const page of context.pages()) addPageListeners(page);
  context.on('page', addPageListeners);
}

async function firstPage(browser) {
  const context = browser.contexts()[0];
  if (!context) throw new Error('No WebView2 browser context was exposed over CDP.');
  await instrumentContext(context);
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const page = context.pages().find(candidate => !candidate.isClosed());
    if (page) {
      await page.waitForURL(url => url.hostname === 'tauri.localhost' || url.protocol === 'tauri:', { timeout: WAIT_MS });
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
      return { page, context };
    }
    await delay(200);
  }
  throw new Error('The Tauri window did not expose a Playwright page.');
}

async function visible(locator, label) {
  await locator.waitFor({ state: 'visible', timeout: WAIT_MS });
  report.assertions.push({ check: label, passed: true });
  return locator;
}

async function textContains(locator, expected, label) {
  const deadline = Date.now() + WAIT_MS;
  let value = '';
  while (Date.now() < deadline) {
    value = await locator.textContent().catch(() => '');
    if (String(value || '').includes(expected)) {
      report.assertions.push({ check: label, passed: true });
      return;
    }
    await delay(100);
  }
  throw new Error(`${label}: expected text to contain '${expected}', got '${value || ''}'.`);
}

async function valueEquals(locator, expected, label) {
  const value = await locator.inputValue();
  if (value !== expected) throw new Error(`${label}: expected '${expected}', got '${value}'.`);
  report.assertions.push({ check: label, passed: true });
}

async function clickNavigation(page, name) {
  await page.getByRole('navigation').getByRole('link', { name, exact: true }).click();
}

async function capture(page, name) {
  const output = path.join(REPORT_DIR, `${name}.png`);
  await page.screenshot({ path: output, fullPage: true });
  report.screenshots.push(path.relative(ROOT, output));
}

async function readIndexedDbSnapshot(page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('kanji-trainer', 2);
    const db = await new Promise((resolve, reject) => {
      open.onerror = () => reject(open.error || new Error('IndexedDB open failed.'));
      open.onsuccess = () => resolve(open.result);
    });
    const transaction = db.transaction(['kanji', 'sessions', 'attempts'], 'readonly');
    const transactionDone = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
    });
    const read = storeName => new Promise((resolve, reject) => {
      const request = transaction.objectStore(storeName).getAll();
      request.onerror = () => reject(request.error || new Error(`IndexedDB read failed for ${storeName}.`));
      request.onsuccess = () => resolve(request.result);
    });
    const [kanji, sessions, attempts] = await Promise.all([
      read('kanji'),
      read('sessions'),
      read('attempts'),
    ]);
    await transactionDone;
    db.close();
    const preferences = (() => {
      try { return JSON.parse(localStorage.getItem('kanji-settings') || '{"practiceSize":"all","feedback":"detailed"}'); }
      catch { return { practiceSize: 'all', feedback: 'detailed' }; }
    })();
    return {
      format: 'kanji-trainer',
      version: 1,
      exportedAt: new Date().toISOString(),
      kanji,
      sessions,
      attempts,
      settings: {
        practiceSize: ['all', '10', '20', '50', '100'].includes(preferences.practiceSize) ? preferences.practiceSize : 'all',
        feedback: preferences.feedback === 'compact' ? 'compact' : 'detailed',
        theme: localStorage.getItem('kanji-theme') === 'dark' ? 'dark' : 'light',
      },
    };
  });
}

async function deleteKanjiFromIndexedDb(page, character) {
  await page.evaluate(async target => {
    const open = indexedDB.open('kanji-trainer', 2);
    const db = await new Promise((resolve, reject) => {
      open.onerror = () => reject(open.error || new Error('IndexedDB open failed.'));
      open.onsuccess = () => resolve(open.result);
    });
    const readTransaction = db.transaction('kanji', 'readonly');
    const records = await new Promise((resolve, reject) => {
      const request = readTransaction.objectStore('kanji').getAll();
      request.onerror = () => reject(request.error || new Error('Kanji read failed.'));
      request.onsuccess = () => resolve(request.result);
    });
    const record = records.find(item => item.kanji === target);
    if (!record) throw new Error(`Kanji ${target} was not present before restore.`);
    const transaction = db.transaction('kanji', 'readwrite');
    const transactionDone = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Kanji delete failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Kanji delete aborted.'));
    });
    transaction.objectStore('kanji').delete(record.id);
    await transactionDone;
    db.close();
  }, character);
}

async function runSmoke() {
  const executable = path.resolve(parseExecutable(process.argv));
  report.executable = executable;
  await mkdir(PROFILE_DIR, { recursive: true });
  const executableInfo = await stat(executable).catch(() => null);
  if (!executableInfo?.isFile()) throw new Error(`Compiled executable was not found: ${executable}`);

  let desktop = await launchDesktop(executable);
  let first;
  try {
    first = await firstPage(desktop.browser);
    const { page } = first;
    const origin = new URL(page.url()).origin;
    if (!origin || origin === 'null') throw new Error(`Could not determine the Tauri page origin from '${page.url()}'.`);

    await page.goto(`${origin}/#/library`);
    await visible(page.getByRole('heading', { name: 'Kho Kanji', exact: true }), 'library route opens');
    const csv = Buffer.from('Kanji,Âm Hán Việt\n散,TÁN/TẢN\n', 'utf8');
    await page.getByLabel('Chọn tệp Excel hoặc CSV', { exact: true }).setInputFiles({
      name: 'desktop-smoke.csv',
      mimeType: 'text/csv',
      buffer: csv,
    });
    await visible(page.getByRole('checkbox', { name: 'Tôi xác nhận nhập dữ liệu theo bản xem trước', exact: true }), 'CSV preview is visible');
    await page.getByRole('checkbox', { name: 'Tôi xác nhận nhập dữ liệu theo bản xem trước', exact: true }).check();
    await page.getByRole('button', { name: 'Xác nhận nhập', exact: true }).click();
    await visible(page.getByRole('button', { name: 'Sửa 散', exact: true }), 'CSV import commits 散');
    const libraryRow = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Sửa 散', exact: true }) });
    await textContains(libraryRow, '2 âm', 'library displays two required readings');
    await textContains(libraryRow, 'TÁN / TẢN', 'library displays both readings');
    await capture(page, '01-library-import');

    await clickNavigation(page, 'Luyện tập');
    const practiceInput = page.getByLabel('Âm Hán Việt cho 散', { exact: true });
    await visible(practiceInput, 'table practice opens');
    const practiceRow = page.locator('[data-kanji="散"]');
    await practiceInput.fill('TÁN');
    await page.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
    await textContains(practiceRow, 'Sai', 'partial reading is incorrect');
    await practiceInput.fill('TẢN/TÁN');
    await page.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
    await textContains(practiceRow, 'Đúng', 'reverse reading order is correct');
    await visible(page.getByText('Đã lưu trên thiết bị', { exact: true }), 'table history is persisted');

    await clickNavigation(page, 'Thống kê');
    await visible(page.getByRole('heading', { name: 'Thống kê', exact: true }), 'statistics route opens');
    await textContains(page.getByTestId('metric-attempts'), '2', 'statistics count two attempts');
    await textContains(page.getByTestId('metric-correct'), '1', 'statistics count one correct attempt');
    await textContains(page.getByTestId('metric-incorrect'), '1', 'statistics count one incorrect attempt');
    await capture(page, '02-statistics');

    await clickNavigation(page, 'Flashcard');
    await visible(page.getByRole('heading', { name: 'Flashcard', exact: true }), 'flashcard route opens');
    await textContains(page.locator('.flashcard-count'), '2 âm', 'flashcard shows two required readings');
    await page.getByLabel('Âm Hán Việt cho 散', { exact: true }).fill('TÁN');
    await page.getByRole('button', { name: 'Kiểm tra', exact: true }).click();
    await textContains(page.locator('.flashcard-card'), 'Sai', 'flashcard also rejects partial readings');
    await visible(page.getByText('Đã lưu trên thiết bị', { exact: true }), 'flashcard check is persisted');
    await clickNavigation(page, 'Ôn câu sai');
    await visible(page.getByRole('heading', { name: 'Ôn câu sai', exact: true }), 'wrong-answer route opens');
    const wrongStart = page.getByRole('button', { name: 'Bắt đầu ôn câu sai', exact: true });
    await visible(wrongStart, 'wrong-answer action is visible');
    if (await wrongStart.isDisabled()) throw new Error('Wrong-answer practice should be available after a recorded incorrect attempt.');
    report.assertions.push({ check: 'wrong-answer action enabled', passed: true });
    await wrongStart.click();
    await page.getByLabel('Âm Hán Việt cho 散', { exact: true }).fill('TẢN/TÁN');
    await page.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
    await visible(page.getByText('Đã lưu trên thiết bị', { exact: true }), 'wrong-answer check is persisted');
    await textContains(page.locator('.practice-row'), 'Đúng', 'wrong-answer practice accepts all readings');

    if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.locator('.theme-button').click();
    const theme = await page.locator('html').getAttribute('data-theme');
    if (theme !== 'dark') throw new Error(`Theme did not switch to dark (got '${theme}').`);
    report.assertions.push({ check: 'dark theme applies', passed: true });

    await clickNavigation(page, 'Luyện tập');
    await practiceInput.fill('TÁN');
    await visible(page.getByText('Đã lưu trên thiết bị', { exact: true }), 'draft is saved before reload');
    await page.reload();
    const reloadedPracticeInput = page.getByLabel('Âm Hán Việt cho 散', { exact: true });
    await visible(reloadedPracticeInput, 'table practice remains after reload');
    await valueEquals(reloadedPracticeInput, 'TÁN', 'draft survives browser reload');
    if (await page.locator('html').getAttribute('data-theme') !== 'dark') throw new Error('Dark theme did not survive browser reload.');
    report.assertions.push({ check: 'dark theme survives browser reload', passed: true });
    await capture(page, '03-practice-draft');

    const backup = await readIndexedDbSnapshot(page);
    if (backup.kanji.length !== 1 || backup.attempts.length !== 4) throw new Error('IndexedDB snapshot did not contain the expected library/history before restore.');
    await deleteKanjiFromIndexedDb(page, '散');
    await clickNavigation(page, 'Cài đặt');
    await page.getByTestId('settings-restore-file').setInputFiles({
      name: 'desktop-smoke-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup), 'utf8'),
    });
    await visible(page.getByTestId('settings-backup-preview'), 'JSON backup preview is visible');
    await page.getByTestId('settings-restore').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Khôi phục dữ liệu', exact: true }).click();
    await delay(900);
    await clickNavigation(page, 'Kho Kanji');
    const restoredRow = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Sửa 散', exact: true }) });
    await visible(page.getByRole('button', { name: 'Sửa 散', exact: true }), 'JSON restore restores the Kanji');
    await textContains(restoredRow, '2 âm', 'restored Kanji keeps its reading count');
    await clickNavigation(page, 'Luyện tập');
    await valueEquals(page.getByLabel('Âm Hán Việt cho 散', { exact: true }), 'TÁN', 'JSON restore restores the draft');
    await capture(page, '04-after-restore');
  } finally {
    await stopDesktop(desktop);
  }

  // Reuse the exact same WebView2 profile to prove IndexedDB/localStorage
  // persistence after process termination, rather than merely a page reload.
  desktop = await launchDesktop(executable);
  try {
    const second = await firstPage(desktop.browser);
    const origin = new URL(second.page.url()).origin;
    await second.page.goto(`${origin}/#/practice`);
    await valueEquals(second.page.getByLabel('Âm Hán Việt cho 散', { exact: true }), 'TÁN', 'draft survives a full executable relaunch');
    if (await second.page.locator('html').getAttribute('data-theme') !== 'dark') throw new Error('Dark theme did not survive a full executable relaunch.');
    report.assertions.push({ check: 'dark theme survives executable relaunch', passed: true });
    await clickNavigation(second.page, 'Thống kê');
    await textContains(second.page.getByTestId('metric-attempts'), '4', 'history survives executable relaunch');
    await clickNavigation(second.page, 'Kho Kanji');
    const relaunchedRow = second.page.getByRole('article').filter({ has: second.page.getByRole('button', { name: 'Sửa 散', exact: true }) });
    await textContains(relaunchedRow, '2 âm', 'reading count survives executable relaunch');
    await capture(second.page, '05-after-relaunch');
  } finally {
    await stopDesktop(desktop);
  }
}

async function main() {
  await mkdir(REPORT_DIR, { recursive: true });
  try {
    await runSmoke();
    if (report.externalRequests.length || report.consoleErrors.length || report.pageErrors.length) {
      throw new Error('The packaged application reported an external request or runtime error; inspect the report.');
    }
    report.outcome = 'passed';
  } catch (error) {
    report.error = error?.stack || error?.message || String(error);
  } finally {
    report.completedAt = new Date().toISOString();
    await writeFile(path.join(REPORT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ outcome: report.outcome, report: path.relative(ROOT, path.join(REPORT_DIR, 'report.json')), externalRequests: report.externalRequests.length, consoleErrors: report.consoleErrors.length, pageErrors: report.pageErrors.length })}\n`);
  }
  if (report.outcome !== 'passed') process.exitCode = 1;
}

await main();

