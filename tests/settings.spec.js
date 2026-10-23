import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { read, utils } from 'xlsx';

async function seed(page, count = 12) {
  await page.goto('/');
  await page.evaluate(async count => {
    const { openDatabase, createKanjiRepository } = await import('/src/data/index.js');
    const db = await openDatabase();
    const repository = createKanjiRepository(db);
    await repository.add({ id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] });
    // Synthetic load fixtures, not a dictionary or sample library.
    for (let index = 1; index < count; index += 1) {
      await repository.add({ id: `fixture-${index}`, kanji: String.fromCodePoint(0x4e00 + index), hanViet: ['HỌC'] });
    }
    db.close();
  }, count);
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const { openDatabase } = await import('/src/data/index.js');
    const db = await openDatabase();
    const tx = db.transaction(['kanji', 'sessions', 'attempts'], 'readonly');
    const values = await Promise.all(['kanji', 'sessions', 'attempts'].map(name => tx.objectStore(name).getAll()));
    await tx.done;
    db.close();
    return { kanji: values[0], sessions: values[1], attempts: values[2] };
  });
}

async function settings(page) {
  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cài đặt', exact: true })).toBeVisible();
}

async function checkSan(page) {
  await page.getByRole('navigation').getByRole('link', { name: 'Luyện tập', exact: true }).click();
  await page.getByLabel('Âm Hán Việt cho 散', { exact: true }).fill('TÁN');
  await page.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
  await expect(page.getByText('Đã lưu trên thiết bị', { exact: true })).toBeVisible();
}

test('preferences persist and affect new sessions without changing saved drafts or grading', async ({ page }) => {
  await seed(page);
  await checkSan(page);
  await expect(page.locator('.answer-feedback').first()).toContainText('đủ 2 âm');
  await settings(page);
  await page.getByTestId('settings-practice-size').selectOption('10');
  await page.getByRole('radio', { name: 'Gọn', exact: true }).check();
  await page.getByTestId('settings-theme-dark').click();
  await page.reload();
  await expect(page.getByTestId('settings-practice-size')).toHaveValue('10');
  await expect(page.getByRole('radio', { name: 'Gọn', exact: true })).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('navigation').getByRole('link', { name: 'Luyện tập', exact: true }).click();
  await expect(page.locator('.practice-row')).toHaveCount(12);
  await expect(page.getByLabel('Âm Hán Việt cho 散', { exact: true })).toHaveValue('TÁN');
  await expect(page.locator('.answer-feedback')).toHaveCount(0);
  await expect(page.locator('[data-kanji="散"]')).toHaveClass(/status-incorrect/);
  await settings(page);
  await page.getByTestId('settings-reset-sessions').click();
  await Promise.all([page.waitForEvent('load'), page.getByRole('dialog').getByRole('button', { name: 'Đặt lại phiên', exact: true }).click()]);
  await page.getByRole('navigation').getByRole('link', { name: 'Luyện tập', exact: true }).click();
  await expect(page.locator('.practice-row')).toHaveCount(10);
  await page.getByRole('navigation').getByRole('link', { name: 'Flashcard', exact: true }).click();
  await expect(page.getByLabel('Số thẻ', { exact: true })).toHaveValue('10');
  await expect(page.locator('.flashcard-count')).toContainText('âm');
});

test('complete JSON backup restores library, attempts, unfinished sessions and settings after confirmation', async ({ page }) => {
  await seed(page, 2);
  await checkSan(page);
  await page.getByLabel('Âm Hán Việt cho 散', { exact: true }).fill('TẢN /');
  await expect(page.getByText('Đã lưu trên thiết bị', { exact: true })).toBeVisible();
  await settings(page);
  await page.getByTestId('settings-practice-size').selectOption('20');
  await page.getByRole('radio', { name: 'Gọn', exact: true }).check();
  const before = await snapshot(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('settings-export').click();
  const download = await downloadPromise;
  const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(backup.version).toBe(1);
  expect(backup.kanji).toEqual(before.kanji);
  expect(backup.attempts).toEqual(before.attempts);
  expect(backup.settings).toMatchObject({ practiceSize: '20', feedback: 'compact' });
  await page.evaluate(async () => {
    const { openDatabase, createKanjiRepository } = await import('/src/data/index.js');
    const db = await openDatabase();
    await createKanjiRepository(db).remove('san');
    db.close();
  });
  await page.getByTestId('settings-restore-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.getByTestId('settings-backup-preview')).toBeVisible();
  await page.getByTestId('settings-restore').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Hủy', exact: true }).click();
  expect((await snapshot(page)).kanji).toHaveLength(1);
  await page.getByTestId('settings-restore').click();
  await Promise.all([page.waitForEvent('load'), page.getByRole('dialog').getByRole('button', { name: 'Khôi phục dữ liệu', exact: true }).click()]);
  await expect(page.getByTestId('settings-backup-preview')).toHaveCount(0);
  const restored = await snapshot(page);
  expect(restored.kanji).toEqual(before.kanji);
  expect(restored.attempts).toEqual(before.attempts);
  expect(restored.sessions[0].items).toEqual(before.sessions[0].items);
  await page.getByRole('navigation').getByRole('link', { name: 'Luyện tập', exact: true }).click();
  await expect(page.getByLabel('Âm Hán Việt cho 散', { exact: true })).toHaveValue('TẢN /');
});

test('a changed default is offered for the next Flashcard session while the current session stays intact', async ({ page }) => {
  await seed(page, 25);
  await page.goto('/#/flashcards');
  await expect(page.locator('.flashcard-position')).toHaveText('Thẻ 1 / 25');
  await settings(page);
  await page.getByTestId('settings-practice-size').selectOption('20');
  await page.getByRole('navigation').getByRole('link', { name: 'Flashcard', exact: true }).click();
  await expect(page.locator('.flashcard-position')).toHaveText('Thẻ 1 / 25');
  await expect(page.getByLabel('Số thẻ', { exact: true })).toHaveValue('20');
  await page.getByRole('button', { name: 'Bắt đầu phiên mới', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận bắt đầu', exact: true }).click();
  await expect(page.locator('.flashcard-position')).toHaveText('Thẻ 1 / 20');
  await settings(page);
  await page.getByTestId('settings-practice-size').selectOption('all');
  await page.getByRole('navigation').getByRole('link', { name: 'Flashcard', exact: true }).click();
  await expect(page.getByLabel('Số thẻ', { exact: true })).toHaveValue('all');
  await page.getByRole('button', { name: 'Bắt đầu phiên mới', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận bắt đầu', exact: true }).click();
  await expect(page.locator('.flashcard-position')).toHaveText('Thẻ 1 / 25');
});

test('invalid backup cannot change data and reset cancellation preserves everything', async ({ page }) => {
  await seed(page, 2);
  await checkSan(page);
  const before = await snapshot(page);
  await settings(page);
  await page.getByTestId('settings-restore-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":999}') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('settings-backup-preview')).toHaveCount(0);
  for (const id of ['settings-reset-sessions', 'settings-reset-history']) {
    await page.getByTestId(id).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Hủy', exact: true }).click();
  }
  expect(await snapshot(page)).toEqual(before);
  await page.getByTestId('settings-reset-sessions').click();
  await Promise.all([page.waitForEvent('load'), page.getByRole('dialog').getByRole('button', { name: 'Đặt lại phiên', exact: true }).click()]);
  await expect.poll(async () => (await snapshot(page)).sessions.length).toBe(0);
  expect((await snapshot(page)).attempts).toEqual(before.attempts);
  await page.getByTestId('settings-reset-history').click();
  await Promise.all([page.waitForEvent('load'), page.getByRole('dialog').getByRole('button', { name: 'Xóa lịch sử', exact: true }).click()]);
  await expect.poll(async () => (await snapshot(page)).attempts.length).toBe(0);
  expect((await snapshot(page)).kanji).toEqual(before.kanji);
});

test('settings layout works on mobile in dark mode', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/settings');
  await page.getByTestId('settings-theme-dark').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByTestId('settings-reset-history').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('settings-reset-history')).toBeFocused();
  await page.getByRole('heading', { name: 'Cài đặt', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('settings-mobile-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByTestId('settings-theme-light').click();
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await page.screenshot({ path: test.info().outputPath('settings-desktop-light.png'), fullPage: true });
});

test('large synthetic library can be searched and used for bounded practice', async ({ page }) => {
  await seed(page, 1000);
  await page.goto('/#/library');
  await expect(page.locator('.library-row')).toHaveCount(1000);
  await page.getByLabel('Tìm Kanji hoặc âm Hán Việt', { exact: true }).fill('散');
  await expect(page.locator('.library-row')).toHaveCount(1);
  await settings(page);
  await page.getByTestId('settings-practice-size').selectOption('10');
  await page.getByRole('navigation').getByRole('link', { name: 'Luyện tập', exact: true }).click();
  await expect(page.locator('.practice-row')).toHaveCount(10);
});

test('practice, statistics, spreadsheets and JSON backup work with only the installed local server reachable', async ({ page, context }) => {
  const externalRequests = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    externalRequests.push(url.href);
    return route.abort();
  });
  await seed(page, 2);
  await checkSan(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Thống kê', exact: true }).click();
  await expect(page.getByTestId('metric-attempts')).toContainText('1');
  await expect(page.getByRole('application')).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Kho Kanji', exact: true }).click();
  const spreadsheetDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất Excel', exact: true }).click();
  const sheetFile = await spreadsheetDownload;
  const workbook = read(await readFile(await sheetFile.path()), { type: 'buffer' });
  expect(utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 })[0]).toEqual(['Kanji', 'Âm Hán Việt']);
  await page.getByLabel('Chọn tệp Excel hoặc CSV', { exact: true }).setInputFiles({ name: 'offline.csv', mimeType: 'text/csv', buffer: Buffer.from('Kanji,Âm Hán Việt\n学,HỌC') });
  await page.getByRole('checkbox', { name: 'Tôi xác nhận nhập dữ liệu theo bản xem trước', exact: true }).check();
  await page.getByRole('button', { name: 'Xác nhận nhập', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sửa 学', exact: true })).toBeVisible();
  await settings(page);
  const backupDownload = page.waitForEvent('download');
  await page.getByTestId('settings-export').click();
  const backupFile = await backupDownload;
  const bytes = await readFile(await backupFile.path());
  await page.getByTestId('settings-restore-file').setInputFiles({ name: 'offline.json', mimeType: 'application/json', buffer: bytes });
  await page.getByTestId('settings-restore').click();
  await Promise.all([page.waitForEvent('load'), page.getByRole('dialog').getByRole('button', { name: 'Khôi phục dữ liệu', exact: true }).click()]);
  expect((await snapshot(page)).attempts).toHaveLength(1);
  expect(externalRequests).toEqual([]);
});
