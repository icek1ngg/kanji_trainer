import { test, expect } from '@playwright/test';

async function seed(page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { openDatabase, createKanjiRepository } = await import('/src/data/index.js');
    const { createTablePracticeRepository } = await import('/src/data/tablePractice.js');
    const { setTableAnswer, checkTableAnswer } = await import('/src/domain/tableSession.js');
    const db = await openDatabase();
    const library = createKanjiRepository(db);
    await library.add({ id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] });
    await library.add({ id: 'gaku', kanji: '学', hanViet: ['HỌC'] });
    const practice = createTablePracticeRepository(db);
    let session = await practice.loadOrCreate(await library.list());
    for (const [id, answer] of [['san', 'TÁN'], ['san', 'TÁN/TẢN'], ['gaku', 'HỌC']]) {
      session = await practice.save(checkTableAnswer(setTableAnswer(session, id, answer), id), session.revision);
    }
    // Legacy summary counters and unrecognized rows must never inflate attempts.
    await db.add('sessions', { id: 'old-session', mode: 'table', active: false, checks: 100, correctChecks: 90, incorrectChecks: 10, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), items: [] });
    await db.add('attempts', { id: 'legacy-attempt', sessionId: 'old-session', kanjiId: 'san' });
    db.close();
  });
}

async function expectTotals(page, { kanji = 2, attempts = 3, correct = 2, incorrect = 1, accuracy = '67', multi = 1 } = {}) {
  for (const [id, value] of Object.entries({ kanji, attempts, correct, incorrect, accuracy, 'multi-reading': multi })) {
    await expect(page.getByTestId(`metric-${id}`)).toContainText(String(value));
  }
}

test('dashboard displays actual library and recorded attempts without summing legacy counters', async ({ page }) => {
  await seed(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Tổng quan', exact: true })).toBeVisible();
  await expectTotals(page);
  await expect(page.getByText('散', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('2 âm', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Bắt đầu luyện tập', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Luyện tập', exact: true })).toBeVisible();
  await page.getByLabel('Âm Hán Việt cho 学', { exact: true }).fill('WRONG');
  await page.getByRole('button', { name: 'Kiểm tra 学', exact: true }).click();
  await expect(page.getByText('Đã lưu trên thiết bị', { exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Tổng quan', exact: true }).click();
  await expectTotals(page, { attempts: 4, correct: 2, incorrect: 2, accuracy: '50' });
});

test('statistics keep history and latest status distinct, refresh correctly, and never mutate storage', async ({ page }) => {
  await seed(page);
  const snapshot = () => page.evaluate(async () => {
    const { openDatabase } = await import('/src/data/index.js');
    const db = await openDatabase();
    const result = { kanji: await db.getAll('kanji'), sessions: await db.getAll('sessions'), attempts: await db.getAll('attempts') };
    db.close();
    return result;
  });
  const before = await snapshot();
  await page.getByRole('navigation').getByRole('link', { name: 'Thống kê', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Thống kê', exact: true })).toBeVisible();
  await expectTotals(page);
  await page.getByRole('button', { name: 'Làm mới số liệu', exact: true }).click();
  await expectTotals(page);
  expect(await snapshot()).toEqual(before);
  await page.evaluate(async () => {
    const { openDatabase, createKanjiRepository } = await import('/src/data/index.js');
    const db = await openDatabase();
    await createKanjiRepository(db).remove('san');
    db.close();
  });
  await page.getByRole('button', { name: 'Làm mới số liệu', exact: true }).click();
  await expectTotals(page, { kanji: 1, multi: 0 });
  await expect(page.getByText('Đã xóa khỏi kho', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.statistics-history-table tbody tr').filter({ hasText: '散' }).first()).toContainText('Đã xóa khỏi kho');
});

test('history and recent Kanji display original check time after a delayed commit', async ({ page }) => {
  await seed(page);
  const eventTime = '2026-10-20T03:00:00.000Z';
  await page.evaluate(async (createdAt) => {
    const { openDatabase } = await import('/src/data/index.js');
    const db = await openDatabase();
    const attempts = await db.getAll('attempts');
    for (const attempt of attempts.filter(item => item.requiredReadings)) {
      await db.put('attempts', { ...attempt, createdAt, checkedAt: '2026-10-22T03:00:00.000Z' });
    }
    db.close();
  }, eventTime);
  await page.goto('/#/statistics');
  await expect(page.locator('.statistics-history-table time').first()).toHaveAttribute('datetime', eventTime);
  await expect(page.locator('.statistics-kanji-result time').first()).toHaveAttribute('datetime', eventTime);
});

test('empty statistics are zero and mobile charts do not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/statistics');
  await expect(page.getByRole('heading', { name: 'Thống kê', exact: true })).toBeVisible();
  await expectTotals(page, { kanji: 0, attempts: 0, correct: 0, incorrect: 0, accuracy: '0', multi: 0 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('statistics-mobile-empty.png'), fullPage: true });
});

test('dashboard mobile dark layout renders populated activity data', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await seed(page);
  await page.reload();
  await expectTotals(page);
  await page.getByRole('button', { name: /Chuyển sang giao diện tối/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('dashboard-mobile-dark.png'), fullPage: true });
});

test('daily activity and paginated history show recorded totals without counting page changes', async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    const { openDatabase } = await import('/src/data/index.js');
    const { createPracticeAttempt } = await import('/src/domain/history.js');
    const db = await openDatabase();
    const tx = db.transaction('attempts', 'readwrite');
    for (let index = 0; index < 22; index += 1) {
      await tx.store.add({ ...createPracticeAttempt({ session: { id: 'fixture-session', mode: 'table' }, item: { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'], answer: 'TÁN' }, isCorrect: false, id: `fixture-${index}` }), sequence: index + 10, checkedAt: new Date().toISOString() });
    }
    await tx.done;
    db.close();
  });
  await page.goto('/#/statistics');
  await expectTotals(page, { attempts: 25, correct: 2, incorrect: 23, accuracy: '8' });
  await page.getByText('Xem dữ liệu theo ngày', { exact: true }).click();
  const dailyTable = page.locator('.statistics-data-table');
  await expect(dailyTable.locator('tbody tr').last()).toContainText('25');
  await page.getByRole('button', { name: 'Trang sau', exact: true }).click();
  await expect(page.getByText('Trang 2 / 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Trang trước', exact: true }).click();
  await expectTotals(page, { attempts: 25, correct: 2, incorrect: 23, accuracy: '8' });
});

test('storage errors are explicit instead of displaying false zero totals', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
  await page.goto('/#/statistics');
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByTestId('metric-attempts')).toHaveCount(0);
});
