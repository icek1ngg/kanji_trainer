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
  await page.goto('/#/flashcards');
  await expect(page.getByLabel('Âm Hán Việt cho 散', { exact: true })).toBeVisible();
}

const answer = (page, kanji = '散') => page.getByLabel(`Âm Hán Việt cho ${kanji}`, { exact: true });
const card = (page, kanji = '散') => page.locator(`[data-kanji="${kanji}"]`);
async function saved(page) { await expect(page.getByText('Đã lưu trên thiết bị', { exact: true })).toBeVisible(); }

test('Flashcards require all readings and reveal only on request', async ({ page }) => {
  await seed(page);
  await expect(card(page)).toContainText('2 âm');
  await expect(card(page)).not.toContainText('TÁN / TẢN');
  await answer(page).fill('TÁN');
  await expect(card(page)).toContainText('Chưa kiểm tra');
  await answer(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(card(page)).toContainText('Chưa kiểm tra');
  await answer(page).press('Enter');
  await expect(card(page)).toContainText('Sai');
  await expect(card(page)).not.toContainText('TÁN / TẢN');
  await answer(page).fill('TẢN');
  await page.getByRole('button', { name: /^Kiểm tra(?: .+)?$/ }).click();
  await expect(card(page)).toContainText('Sai');
  await answer(page).fill('TẢN/TÁN');
  await answer(page).press('Enter');
  await expect(card(page)).toContainText('Đúng');
  await expect(page.getByRole('progressbar', { name: 'Tiến độ Flashcard' })).toHaveAttribute('value', '50');
  await answer(page).fill('TÁN/TÁN');
  await page.getByRole('button', { name: /^Kiểm tra(?: .+)?$/ }).click();
  await expect(card(page)).toContainText('Sai');
  await page.getByRole('button', { name: /^Hiện đáp án(?: .+)?$/ }).click();
  await expect(card(page)).toContainText('TÁN / TẢN');
  await page.getByRole('button', { name: /^Ẩn đáp án(?: .+)?$/ }).click();
  await expect(card(page)).not.toContainText('TÁN / TẢN');
});

test('navigation and refresh preserve drafts, card position, and table sessions independently', async ({ page }) => {
  await seed(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Luyện tập', exact: true }).click();
  await answer(page, '学').fill('học');
  await saved(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Flashcard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Flashcard', exact: true })).toBeVisible();
  await answer(page).fill('tán');
  await expect(answer(page)).toHaveValue('tán');
  await page.getByRole('button', { name: 'Thẻ tiếp theo', exact: true }).click();
  await answer(page, '学').fill('HỌC');
  await saved(page);
  await page.reload();
  await expect(answer(page, '学')).toHaveValue('HỌC');
  await expect(page.getByRole('button', { name: 'Thẻ tiếp theo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Thẻ trước', exact: true }).click();
  await expect(answer(page)).toHaveValue('tán');
  await expect(page.getByRole('button', { name: 'Thẻ trước', exact: true })).toBeDisabled();
  await page.getByRole('navigation').getByRole('link', { name: 'Luyện tập', exact: true }).click();
  await expect(answer(page, '学')).toHaveValue('học');
});

test('completed session summary and retry use actual checked results and preserve archived sessions', async ({ page }) => {
  await seed(page);
  await answer(page).fill('TÁN');
  await page.getByRole('button', { name: /^Kiểm tra(?: .+)?$/ }).click();
  await page.getByRole('button', { name: 'Thẻ tiếp theo', exact: true }).click();
  await answer(page, '学').fill('học');
  await page.getByRole('button', { name: /^Kiểm tra(?: .+)?$/ }).click();
  await expect(page.getByRole('heading', { name: 'Kết quả phiên', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Tiến độ Flashcard' })).toHaveAttribute('value', '100');
  await page.getByRole('button', { name: 'Luyện lại thẻ sai', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận luyện lại', exact: true }).click();
  await expect(answer(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Thẻ tiếp theo', exact: true })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Kết quả phiên', exact: true })).toHaveCount(0);
  const stored = await page.evaluate(async () => {
    const { openDatabase } = await import('/src/data/index.js');
    const db = await openDatabase();
    const sessions = (await db.getAll('sessions')).filter(session => session.mode === 'flashcard');
    const attempts = await db.getAll('attempts');
    db.close();
    return { count: sessions.length, active: sessions.filter(session => session.active).length, attempts: attempts.length };
  });
  expect(stored).toEqual({ count: 2, active: 1, attempts: 2 });
});

test('session settings apply only after confirmation and persist after refresh', async ({ page }) => {
  await seed(page);
  await answer(page).fill('draft');
  await page.getByRole('combobox', { name: 'Số thẻ', exact: true }).selectOption('10');
  await page.getByRole('combobox', { name: 'Thứ tự', exact: true }).selectOption('random');
  await expect(answer(page)).toHaveValue('draft');
  await page.getByRole('button', { name: 'Bắt đầu phiên mới', exact: true }).click();
  await page.getByRole('button', { name: 'Hủy', exact: true }).click();
  await expect(answer(page)).toHaveValue('draft');
  await page.getByRole('button', { name: 'Bắt đầu phiên mới', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận bắt đầu', exact: true }).click();
  await expect(page.getByRole('textbox')).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Số thẻ', exact: true })).toHaveValue('10');
  await expect(page.getByRole('combobox', { name: 'Thứ tự', exact: true })).toHaveValue('random');
});

test('rapid drafts persist without double-counting unchanged checks', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await seed(page);
  await answer(page).pressSequentially('TÁN/TẢN', { delay: 1 });
  await page.getByRole('button', { name: /^Kiểm tra(?: .+)?$/ }).click();
  await page.getByRole('button', { name: /^Kiểm tra(?: .+)?$/ }).click();
  await saved(page);
  await page.reload();
  await expect(answer(page)).toHaveValue('TÁN/TẢN');
  await expect(card(page)).toContainText('Đúng');
  const checks = await page.evaluate(async () => {
    const { openDatabase } = await import('/src/data/index.js');
    const db = await openDatabase();
    const sessions = await db.getAll('sessions');
    db.close();
    return sessions.find(session => session.mode === 'flashcard' && session.active).checks;
  });
  expect(checks).toBe(1);
  expect(errors).toEqual([]);
});

test('Flashcard drafts survive storage errors and retry without changing table data', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    window.__flashIndexedDB = window.indexedDB;
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  });
  await answer(page).fill('TẢN/TÁN');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(answer(page)).toHaveValue('TẢN/TÁN');
  await page.evaluate(() => Object.defineProperty(window, 'indexedDB', { configurable: true, value: window.__flashIndexedDB }));
  await page.getByRole('button', { name: 'Thử lưu lại', exact: true }).click();
  await saved(page);
  await page.reload();
  await expect(answer(page)).toHaveValue('TẢN/TÁN');
});

test('conflicted Flashcard edits cannot overwrite another tab', async ({ page }) => {
  await seed(page);
  const second = await page.context().newPage();
  await second.goto('/#/flashcards');
  await expect(answer(second)).toBeVisible();
  await answer(page).fill('TÁN/TẢN');
  await saved(page);
  await answer(second).fill('TÁN');
  await expect(second.getByRole('alert')).toContainText('thay đổi');
  await answer(second).fill('TẢN');
  await second.getByRole('button', { name: /^Kiểm tra(?: .+)?$/ }).click();
  await second.getByRole('button', { name: 'Tải lại phiên', exact: true }).click();
  await expect(second.getByRole('dialog')).toContainText(/bỏ|mất/);
  await second.getByRole('button', { name: 'Xác nhận tải lại', exact: true }).click();
  await expect(answer(second)).toHaveValue('TÁN/TẢN');
  await second.close();
});

test('Flashcards render on mobile in dark mode with edited reading counts on resume', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await seed(page);
  await answer(page).fill('TÁN');
  await saved(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Kho Kanji', exact: true }).click();
  await page.getByRole('button', { name: 'Sửa 散', exact: true }).click();
  await page.getByLabel('Âm Hán Việt', { exact: true }).fill('TÁN');
  await page.getByRole('button', { name: 'Lưu Kanji', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Flashcard', exact: true }).click();
  await expect(card(page)).toContainText('1 âm');
  await expect(answer(page)).toHaveValue('TÁN');
  await page.getByRole('button', { name: /Chuyển sang giao diện tối/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('flashcards-mobile-dark.png'), fullPage: true });
});
