import { test, expect } from '@playwright/test';

async function seed(page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { openDatabase, createKanjiRepository } = await import('/src/data/index.js');
    const db = await openDatabase();
    const repo = createKanjiRepository(db);
    await repo.add({ id: 'a-san', kanji: '散', hanViet: ['TÁN', 'TẢN'] });
    await repo.add({ id: 'b-gaku', kanji: '学', hanViet: ['HỌC'] });
    db.close();
  });
}

async function attempts(page) {
  return page.evaluate(async () => {
    const { openDatabase } = await import('/src/data/index.js');
    const db = await openDatabase();
    const entries = await db.getAll('attempts');
    db.close();
    return entries;
  });
}

async function saveDone(page) {
  await expect(page.getByText('Đã lưu trên thiết bị', { exact: true })).toBeVisible();
}

async function makeWrong(page) {
  await seed(page);
  await page.goto('/#/practice');
  await page.getByLabel('Âm Hán Việt cho 散', { exact: true }).fill('TÁN');
  await page.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
  await saveDone(page);
}

test('only explicit checks enter history and latest checked status ignores draft edits', async ({ page }) => {
  await makeWrong(page);
  await page.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
  await page.getByLabel('Âm Hán Việt cho 散', { exact: true }).fill('TẢN');
  await page.getByRole('button', { name: 'Hiện đáp án 散', exact: true }).click();
  await page.getByRole('button', { name: 'Ẩn đáp án 散', exact: true }).click();
  await saveDone(page);
  expect(await attempts(page)).toHaveLength(1);
  await page.getByRole('navigation').getByRole('link', { name: 'Ôn câu sai', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ôn câu sai', exact: true })).toBeVisible();
  await expect(page.getByText('散', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lịch sử luyện tập', exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Luyện tập', exact: true }).click();
  await page.getByLabel('Âm Hán Việt cho 散', { exact: true }).fill('TẢN/TÁN');
  await page.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
  await saveDone(page);
  expect(await attempts(page)).toHaveLength(2);
  await page.getByRole('navigation').getByRole('link', { name: 'Ôn câu sai', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bắt đầu ôn câu sai', exact: true })).toBeDisabled();
});

test('manual wrong-answer session records repeated retries and survives refresh', async ({ page }) => {
  await makeWrong(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Ôn câu sai', exact: true }).click();
  await page.getByRole('button', { name: 'Bắt đầu ôn câu sai', exact: true }).click();
  const input = page.getByLabel('Âm Hán Việt cho 散', { exact: true });
  await expect(input).toBeVisible();
  await expect(page.locator('[data-kanji="散"]').filter({ has: input })).toContainText('2 âm');
  await input.fill('TẢN');
  await expect(page.locator('[data-kanji="散"]').filter({ has: input })).not.toContainText('TÁN / TẢN');
  await page.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
  await saveDone(page);
  await expect(page.locator('[data-kanji="散"]').filter({ has: input })).not.toContainText('TÁN / TẢN');
  await page.screenshot({ path: test.info().outputPath('wrong-answers-desktop.png'), fullPage: true });
  await page.reload();
  await expect(input).toHaveValue('TẢN');
  await input.fill('tản/tán');
  await input.press('Enter');
  await saveDone(page);
  const history = await attempts(page);
  expect(history).toHaveLength(3);
  expect(history.filter(item => item.mode === 'wrong')).toHaveLength(2);
  await expect(page.getByRole('button', { name: 'Bắt đầu ôn câu sai', exact: true })).toBeDisabled();
  await expect(page.getByRole('heading', { name: /Kết quả/ })).toBeVisible();
});

test('history scope distinguishes a past session mistake from a later correction in another mode', async ({ page }) => {
  await makeWrong(page);
  const previous = (await attempts(page))[0].sessionId;
  await page.getByRole('navigation').getByRole('link', { name: 'Flashcard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Flashcard', exact: true })).toBeVisible();
  await page.getByLabel('Âm Hán Việt cho 散', { exact: true }).fill('TÁN/TẢN');
  await page.getByRole('button', { name: 'Kiểm tra', exact: true }).click();
  await saveDone(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Ôn câu sai', exact: true }).click();
  const scope = page.getByRole('combobox', { name: 'Phạm vi câu sai', exact: true });
  await expect(scope).toHaveValue('all');
  await expect(page.getByRole('button', { name: 'Bắt đầu ôn câu sai', exact: true })).toBeDisabled();
  await scope.selectOption(previous);
  await expect(page.getByRole('button', { name: 'Bắt đầu ôn câu sai', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Bắt đầu ôn câu sai', exact: true }).click();
  await expect(page.getByTestId('wrong-active-scope')).not.toContainText('Tất cả lịch sử');
  const source = await page.getByTestId('wrong-active-scope').textContent();
  await scope.selectOption('all');
  await expect(page.getByTestId('wrong-active-scope')).toHaveText(source);
  expect(await attempts(page)).toHaveLength(2);
});

test('wrong-answer page remains usable on mobile and shows a real empty history', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/wrong-answers');
  await expect(page.getByRole('heading', { name: 'Ôn câu sai', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bắt đầu ôn câu sai', exact: true })).toBeDisabled();
  expect(await attempts(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('wrong-answers-mobile.png'), fullPage: true });
});

test('a failed check save records its attempt once when the saved draft is retried', async ({ page }) => {
  await seed(page);
  await page.goto('/#/practice');
  const input = page.getByLabel('Âm Hán Việt cho 散', { exact: true });
  await input.fill('TÁN');
  await saveDone(page);
  await page.evaluate(() => {
    window.__historyIndexedDB = window.indexedDB;
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  });
  await page.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.evaluate(() => Object.defineProperty(window, 'indexedDB', { configurable: true, value: window.__historyIndexedDB }));
  expect(await attempts(page)).toHaveLength(0);
  await page.getByRole('button', { name: 'Thử lưu lại', exact: true }).click();
  await saveDone(page);
  expect(await attempts(page)).toHaveLength(1);
  await page.reload();
  await page.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
  await saveDone(page);
  expect(await attempts(page)).toHaveLength(1);
});

test('wrong-session save errors retain drafts and do not duplicate attempts on retry', async ({ page }) => {
  await makeWrong(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Ôn câu sai', exact: true }).click();
  await page.getByRole('button', { name: 'Bắt đầu ôn câu sai', exact: true }).click();
  const input = page.getByLabel('Âm Hán Việt cho 散', { exact: true });
  await input.pressSequentially('TÁN/TẢN', { delay: 1 });
  await saveDone(page);
  await page.evaluate(() => {
    window.__wrongIndexedDB = window.indexedDB;
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  });
  await input.press('Enter');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.evaluate(() => Object.defineProperty(window, 'indexedDB', { configurable: true, value: window.__wrongIndexedDB }));
  expect(await attempts(page)).toHaveLength(1);
  await page.getByRole('button', { name: 'Thử lưu lại', exact: true }).click();
  await saveDone(page);
  expect(await attempts(page)).toHaveLength(2);
  await page.reload();
  await expect(input).toHaveValue('TÁN/TẢN');
  expect(await attempts(page)).toHaveLength(2);
});

test('legacy attempt rows are preserved without being displayed as incorrect answers', async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    const { openDatabase } = await import('/src/data/index.js');
    const db = await openDatabase();
    await db.add('attempts', { id: 'legacy-history', sessionId: 'legacy-session', kanjiId: 'a-san' });
    db.close();
  });
  await page.goto('/#/wrong-answers');
  await expect(page.getByRole('heading', { name: 'Ôn câu sai', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bắt đầu ôn câu sai', exact: true })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Chưa có lượt kiểm tra', exact: true })).toBeVisible();
  expect(await attempts(page)).toHaveLength(1);
});

test('conflicting wrong-session edits cannot write duplicate or stale attempts', async ({ page }) => {
  await makeWrong(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Ôn câu sai', exact: true }).click();
  await page.getByRole('button', { name: 'Bắt đầu ôn câu sai', exact: true }).click();
  const second = await page.context().newPage();
  await second.goto('/#/wrong-answers');
  await expect(second.getByLabel('Âm Hán Việt cho 散', { exact: true })).toBeVisible();
  await page.getByLabel('Âm Hán Việt cho 散', { exact: true }).fill('TÁN/TẢN');
  await page.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
  await saveDone(page);
  await second.getByLabel('Âm Hán Việt cho 散', { exact: true }).fill('TẢN');
  await expect(second.getByRole('alert')).toContainText('thay đổi');
  await second.getByLabel('Âm Hán Việt cho 散', { exact: true }).fill('TÁN');
  await second.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
  expect(await attempts(page)).toHaveLength(2);
  await second.getByRole('button', { name: 'Tải lại phiên', exact: true }).click();
  await second.getByRole('button', { name: 'Xác nhận tải lại', exact: true }).click();
  await expect(second.getByLabel('Âm Hán Việt cho 散', { exact: true })).toHaveValue('TÁN/TẢN');
  expect(await attempts(page)).toHaveLength(2);
  await second.close();
});
