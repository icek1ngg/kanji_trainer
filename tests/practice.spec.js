import { test, expect } from '@playwright/test';

async function seed(page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { openDatabase, createKanjiRepository } = await import('/src/data/index.js');
    const db = await openDatabase();
    const repo = createKanjiRepository(db);
    await repo.add({ id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] });
    await repo.add({ id: 'gaku', kanji: '学', hanViet: ['HỌC'] });
    db.close();
  });
  await page.goto('/#/practice');
  await expect(page.getByLabel('Âm Hán Việt cho 散', { exact: true })).toBeVisible();
}

const row = (page, kanji) => page.locator(`[data-kanji="${kanji}"]`);
const answer = (page, kanji) => page.getByLabel(`Âm Hán Việt cho ${kanji}`, { exact: true });
const check = (page, kanji) => page.getByRole('button', { name: `Kiểm tra ${kanji}`, exact: true });
async function saved(page) { await expect(page.getByText('Đã lưu trên thiết bị', { exact: true })).toBeVisible(); }

test('table requires every reading and never reveals answers automatically', async ({ page }) => {
  await seed(page);
  await expect(row(page, '散')).toContainText('2 âm');
  await expect(row(page, '散')).not.toContainText('TÁN / TẢN');
  await answer(page, '散').fill('TÁN');
  await expect(row(page, '散')).toContainText('Chưa kiểm tra');
  await check(page, '散').click();
  await expect(row(page, '散')).toContainText('Sai');
  await expect(row(page, '散')).not.toContainText('TÁN / TẢN');
  await answer(page, '散').fill('TẢN');
  await check(page, '散').click();
  await expect(row(page, '散')).toContainText('Sai');
  await answer(page, '散').fill('TÁN/TẢN');
  await check(page, '散').click();
  await expect(row(page, '散')).toContainText('Đúng');
  await answer(page, '散').fill('tản ; tán');
  await check(page, '散').click();
  await expect(row(page, '散')).toContainText('Đúng');
  await answer(page, '散').fill('TÁN/TÁN');
  await check(page, '散').click();
  await expect(row(page, '散')).toContainText('Sai');
  await page.getByRole('button', { name: 'Hiện đáp án 散', exact: true }).click();
  await expect(row(page, '散')).toContainText('TÁN / TẢN');
  await page.getByRole('button', { name: 'Ẩn đáp án 散', exact: true }).click();
  await expect(row(page, '散')).not.toContainText('TÁN / TẢN');
});

test('Enter checks once, then focuses the next question without adding another check', async ({ page }) => {
  await seed(page);
  const inputs = page.getByRole('textbox');
  const first = inputs.first();
  const label = await first.getAttribute('aria-label');
  await first.fill(label.includes('学') ? 'HỌC' : 'TÁN/TẢN');
  await first.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(page.getByRole('progressbar', { name: 'Tiến độ phiên' })).toHaveAttribute('value', '0');
  await first.press('Enter');
  await expect(page.getByRole('progressbar', { name: 'Tiến độ phiên' })).toHaveAttribute('value', '50');
  await first.press('Enter');
  await expect(inputs.nth(1)).toBeFocused();
  await saved(page);
  const checks = await page.evaluate(async () => {
    const { openDatabase } = await import('/src/data/index.js');
    const db = await openDatabase();
    const sessions = await db.getAll('sessions');
    db.close();
    return sessions.find(session => session.mode === 'table' && session.active).checks;
  });
  expect(checks).toBe(1);
});

test('drafts survive filters, shuffle, navigation and refresh', async ({ page }) => {
  await seed(page);
  await answer(page, '散').fill('TÁN');
  await answer(page, '学').fill('học');
  await check(page, '学').click();
  await page.getByRole('combobox', { name: 'Lọc trạng thái', exact: true }).selectOption('correct');
  await expect(answer(page, '散')).toHaveCount(0);
  await expect(answer(page, '学')).toHaveValue('học');
  await page.getByRole('combobox', { name: 'Lọc trạng thái', exact: true }).selectOption('all');
  await expect(answer(page, '散')).toHaveValue('TÁN');
  await page.getByRole('button', { name: 'Trộn thứ tự', exact: true }).click();
  await saved(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Kho Kanji', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Luyện tập', exact: true }).click();
  await expect(answer(page, '散')).toHaveValue('TÁN');
  await expect(row(page, '学')).toContainText('Đúng');
  await page.reload();
  await expect(answer(page, '散')).toHaveValue('TÁN');
  await expect(row(page, '学')).toContainText('Đúng');
});

test('retry selects only wrong answers and reset starts fresh without deleting old sessions', async ({ page }) => {
  await seed(page);
  await answer(page, '散').fill('TÁN');
  await check(page, '散').click();
  await answer(page, '学').fill('HỌC');
  await check(page, '学').click();
  await page.getByRole('button', { name: 'Luyện lại câu sai', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận luyện lại', exact: true }).click();
  await expect(answer(page, '学')).toHaveCount(0);
  await expect(answer(page, '散')).toHaveValue('');
  await page.getByRole('button', { name: 'Đặt lại phiên', exact: true }).click();
  await page.getByRole('button', { name: 'Hủy', exact: true }).click();
  await expect(answer(page, '学')).toHaveCount(0);
  await page.getByRole('button', { name: 'Đặt lại phiên', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận đặt lại', exact: true }).click();
  await expect(answer(page, '学')).toHaveValue('');
  await expect(answer(page, '散')).toHaveValue('');
  const state = await page.evaluate(async () => {
    const { openDatabase } = await import('/src/data/index.js');
    const db = await openDatabase();
    const sessions = await db.getAll('sessions');
    const history = await db.getAll('attempts');
    db.close();
    return { total: sessions.length, active: sessions.filter(item => item.active).length, attempts: history.length };
  });
  expect(state).toEqual({ total: 3, active: 1, attempts: 2 });
});

test('resuming after library edits refreshes reading count and keeps the draft', async ({ page }) => {
  await seed(page);
  await answer(page, '散').fill('TÁN');
  await check(page, '散').click();
  await saved(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Kho Kanji', exact: true }).click();
  await page.getByRole('button', { name: 'Sửa 散', exact: true }).click();
  await page.getByLabel('Âm Hán Việt', { exact: true }).fill('TÁN');
  await page.getByRole('button', { name: 'Lưu Kanji', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Luyện tập', exact: true }).click();
  await expect(row(page, '散')).toContainText('1 âm');
  await expect(answer(page, '散')).toHaveValue('TÁN');
  await expect(row(page, '散')).toContainText('Chưa kiểm tra');
});

test('practice is usable on mobile and in dark mode', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await seed(page);
  await page.getByRole('button', { name: /Chuyển sang giao diện tối/ }).click();
  await answer(page, '散').fill('TÁN/TẢN');
  await check(page, '散').click();
  await expect(row(page, '散')).toContainText('Đúng');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('practice-mobile-dark.png'), fullPage: true });
});

test('rapid typing saves the latest draft in order without stale-revision failures', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await seed(page);
  await answer(page, '散').pressSequentially('TÁN/TẢN', { delay: 1 });
  await saved(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await expect(answer(page, '散')).toHaveValue('TÁN/TẢN');
  expect(errors).toEqual([]);
});

test('failed storage preserves the draft and allows an explicit save retry', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    window.__practiceIndexedDB = window.indexedDB;
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  });
  await answer(page, '散').fill('TẢN/TÁN');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(answer(page, '散')).toHaveValue('TẢN/TÁN');
  await page.evaluate(() => Object.defineProperty(window, 'indexedDB', { configurable: true, value: window.__practiceIndexedDB }));
  await page.getByRole('button', { name: 'Thử lưu lại', exact: true }).click();
  await saved(page);
  await page.reload();
  await expect(answer(page, '散')).toHaveValue('TẢN/TÁN');
});

test('a conflicted tab cannot overwrite a newer saved session with subsequent edits', async ({ page }) => {
  await seed(page);
  const second = await page.context().newPage();
  await second.goto('/#/practice');
  await expect(answer(second, '散')).toBeVisible();
  await answer(page, '散').fill('TÁN/TẢN');
  await saved(page);
  await answer(second, '散').fill('TẢN');
  await expect(second.getByRole('alert')).toContainText('thay đổi');
  // A second draft must remain local; it cannot guess the now-current revision.
  await answer(second, '散').fill('TÁN');
  await second.getByRole('button', { name: 'Kiểm tra 散', exact: true }).click();
  const persisted = await page.evaluate(async () => {
    const { openDatabase } = await import('/src/data/index.js');
    const db = await openDatabase();
    const sessions = await db.getAll('sessions');
    db.close();
    return sessions.find(session => session.mode === 'table' && session.active).items.find(item => item.id === 'san').answer;
  });
  expect(persisted).toBe('TÁN/TẢN');
  await second.close();
});
