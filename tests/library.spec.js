import { test, expect } from '@playwright/test';

async function add(page, kanji, readings) {
  await page.getByRole('button', { name: 'Thêm Kanji', exact: true }).click();
  await page.getByLabel('Kanji', { exact: true }).fill(kanji);
  await page.getByLabel('Âm Hán Việt', { exact: true }).fill(readings);
  await page.getByRole('button', { name: 'Lưu Kanji', exact: true }).click();
  await expect(page.getByRole('button', { name: `Sửa ${kanji}`, exact: true })).toBeVisible();
}

test('library supports multiple readings, editing, duplicate detection and refresh persistence', async ({ page }) => {
  await page.goto('/#/library');
  await add(page, '散', 'TÁN/TẢN');
  const row = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Sửa 散', exact: true }) });
  await expect(row).toContainText('2 âm');
  await expect(row).toContainText('TÁN / TẢN');
  await page.screenshot({ path: test.info().outputPath('library-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Sửa 散', exact: true }).click();
  await page.getByLabel('Âm Hán Việt', { exact: true }).fill('TÁN');
  await page.getByRole('button', { name: 'Lưu Kanji', exact: true }).click();
  await expect(row).toContainText('1 âm');
  await page.reload();
  await expect(row).toContainText('1 âm');
  await page.getByRole('button', { name: 'Thêm Kanji', exact: true }).click();
  await page.getByLabel('Kanji', { exact: true }).fill('散');
  await page.getByLabel('Âm Hán Việt', { exact: true }).fill('TÁN/TẢN');
  await page.getByRole('button', { name: 'Lưu Kanji', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/đã tồn tại|trùng/i);
  await page.getByRole('button', { name: 'Hủy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toHaveCount(1);
});

test('library searches all readings and deletes selected results only after confirmation', async ({ page }) => {
  await page.goto('/#/library');
  await add(page, '散', 'TÁN;TẢN');
  await add(page, '学', 'HỌC');
  const search = page.getByLabel('Tìm Kanji hoặc âm Hán Việt', { exact: true });
  await search.fill('tản'.normalize('NFD'));
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sửa 学', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Chọn 散', exact: true }).check();
  await page.getByRole('button', { name: /Xóa đã chọn/ }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Xác nhận xóa' });
  await expect(dialog).toContainText('散');
  await page.getByRole('button', { name: 'Hủy xóa', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Xóa đã chọn/ }).click();
  await page.getByRole('button', { name: 'Xác nhận xóa', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toHaveCount(0);
  await search.fill('');
  await expect(page.getByRole('button', { name: 'Sửa 学', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sửa 学', exact: true })).toBeVisible();
});

test('library rejects malformed readings and works on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/library');
  await page.getByRole('button', { name: 'Thêm Kanji', exact: true }).click();
  await page.getByLabel('Kanji', { exact: true }).fill('散');
  await page.getByLabel('Âm Hán Việt', { exact: true }).fill('TÁN//TẢN');
  await page.getByRole('button', { name: 'Lưu Kanji', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Âm Hán Việt', { exact: true }).fill('TÁN｜TẢN');
  await page.getByRole('button', { name: 'Lưu Kanji', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('library-mobile.png'), fullPage: true });
});

test('sort, select-all, confirmed bulk delete and single delete work', async ({ page }) => {
  await page.goto('/#/library');
  await add(page, '散', 'TÁN/TẢN');
  await add(page, '学', 'HỌC');
  await page.getByRole('combobox', { name: 'Sắp xếp', exact: true }).selectOption('count-desc');
  await expect(page.getByRole('article').first()).toContainText('散');
  await page.getByRole('checkbox', { name: 'Chọn tất cả kết quả', exact: true }).check();
  await page.getByRole('button', { name: /Xóa đã chọn/ }).click();
  await expect(page.getByRole('alertdialog')).toContainText('2 Kanji');
  await page.getByRole('button', { name: 'Xác nhận xóa', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kho Kanji đang trống' })).toBeVisible();
  await add(page, '学', 'HỌC');
  await page.getByRole('button', { name: 'Xóa 学', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Xóa 学', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Xóa 学', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận xóa', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kho Kanji đang trống' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Thêm Kanji', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Kho Kanji đang trống' })).toBeVisible();
});

test('preserves supplied capitalization and recovers a record deleted in another tab', async ({ page }) => {
  await page.goto('/#/library');
  await add(page, '散', ' tán ; Tản ');
  const row = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Sửa 散', exact: true }) });
  await expect(row).toContainText('tán / Tản');
  await page.reload();
  await expect(row).toContainText('tán / Tản');
  await page.getByRole('button', { name: 'Sửa 散', exact: true }).click();
  await page.evaluate(async () => {
    const { openDatabase, createKanjiRepository } = await import('/src/data/index.js');
    const db = await openDatabase();
    const repo = createKanjiRepository(db);
    const entry = (await repo.list()).find(record => record.kanji === '散');
    await repo.remove(entry.id);
    db.close();
  });
  await page.getByRole('button', { name: 'Lưu Kanji', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('không còn tồn tại');
  await expect(page.getByRole('heading', { name: 'Kho Kanji đang trống' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lưu Kanji', exact: true })).toHaveCount(0);
});
