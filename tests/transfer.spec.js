import { test, expect } from '@playwright/test';
import { read, utils, write } from 'xlsx';
import { readFile } from 'node:fs/promises';

const csvFile = (text, name = 'kanji.csv') => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') });
const confirmLabel = 'Tôi xác nhận nhập dữ liệu theo bản xem trước';

async function selectFile(page, file) {
  await page.getByLabel('Chọn tệp Excel hoặc CSV', { exact: true }).setInputFiles(file);
}

async function confirmImport(page) {
  await page.getByRole('checkbox', { name: confirmLabel, exact: true }).check();
  await page.getByRole('button', { name: 'Xác nhận nhập', exact: true }).click();
}

test('CSV preview requires confirmation, imports all readings, and exports exactly two columns', async ({ page }) => {
  await page.goto('/#/library');
  await selectFile(page, csvFile('Kanji,Âm Hán Việt\n散,tán/Tản\n学,HỌC'));
  await expect(page.getByRole('button', { name: 'Xác nhận nhập', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toHaveCount(0);
  await confirmImport(page);
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toBeVisible();
  const row = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Sửa 散', exact: true }) });
  await expect(row).toContainText('2 âm');
  await expect(row).toContainText('tán / Tản');
  await page.getByLabel('Tìm Kanji hoặc âm Hán Việt', { exact: true }).fill('学');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất Excel', exact: true }).click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());
  const workbook = read(bytes, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = utils.sheet_to_json(sheet, { header: 1 });
  expect(rows[0]).toEqual(['Kanji', 'Âm Hán Việt']);
  expect(rows).toHaveLength(3);
  expect(rows.slice(1)).toEqual(expect.arrayContaining([['散', 'tán/Tản'], ['学', 'HỌC']]));
  expect(utils.decode_range(sheet['!ref']).e.c).toBe(1);
  await page.getByLabel('Tìm Kanji hoặc âm Hán Việt', { exact: true }).fill('');
  await selectFile(page, { name: 'roundtrip.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
  await expect(page.getByRole('combobox', { name: 'Xử lý Kanji trùng', exact: true })).toHaveValue('skip');
  await confirmImport(page);
  await page.reload();
  await expect(row).toContainText('2 âm');
});

test('duplicate merge and replace are explicit and invalid files leave the library intact', async ({ page }) => {
  await page.goto('/#/library');
  await selectFile(page, csvFile('Kanji,Âm Hán Việt\n散,TÁN'));
  await confirmImport(page);
  const row = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Sửa 散', exact: true }) });
  await expect(row).toContainText('1 âm');
  await selectFile(page, csvFile('Kanji,Âm Hán Việt\n散,TẢN'));
  await page.getByRole('combobox', { name: 'Xử lý Kanji trùng', exact: true }).selectOption('merge');
  await confirmImport(page);
  await expect(row).toContainText('2 âm');
  await selectFile(page, csvFile('Kanji,Âm Hán Việt\n散,TẢN'));
  await page.getByRole('combobox', { name: 'Xử lý Kanji trùng', exact: true }).selectOption('replace');
  await confirmImport(page);
  await expect(row).toContainText('1 âm');
  await expect(row).toContainText('TẢN');
  await selectFile(page, csvFile('Kanji,Âm Hán Việt,Meaning\n散,TÁN,extra'));
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toBeVisible();
  await selectFile(page, csvFile('Kanji,Âm Hán Việt\n学,HỌC\n散,TÁN//TẢN'));
  await expect(page.getByRole('button', { name: 'Xác nhận nhập', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sửa 学', exact: true })).toHaveCount(0);
});

test('Excel template contains only two headers and XLSX previews fit on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/library');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Tải mẫu Excel', exact: true }).click();
  const download = await downloadPromise;
  const workbook = read(await readFile(await download.path()), { type: 'buffer' });
  expect(utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 })).toEqual([['Kanji', 'Âm Hán Việt']]);
  const fixture = utils.book_new();
  utils.book_append_sheet(fixture, utils.aoa_to_sheet([['Kanji', 'Âm Hán Việt'], ['散', 'TÁN｜TẢN']]));
  await selectFile(page, { name: 'kanji.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: write(fixture, { type: 'buffer', bookType: 'xlsx' }) });
  await expect(page.getByRole('button', { name: 'Xác nhận nhập', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('transfer-mobile.png'), fullPage: true });
  await confirmImport(page);
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toBeVisible();
});

test('a library change after preview blocks the stale import until preview is refreshed', async ({ page }) => {
  await page.goto('/#/library');
  await selectFile(page, csvFile('Kanji,Âm Hán Việt\n散,TÁN/TẢN'));
  await expect(page.getByRole('checkbox', { name: confirmLabel, exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const { openDatabase, createKanjiRepository } = await import('/src/data/index.js');
    const db = await openDatabase();
    await createKanjiRepository(db).add({ kanji: '学', hanViet: ['HỌC'] });
    db.close();
  });
  await confirmImport(page);
  await expect(page.getByRole('alert')).toContainText(/thay đổi|thay đổi/i);
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cập nhật bản xem trước', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: confirmLabel, exact: true })).not.toBeChecked();
  await confirmImport(page);
  await expect(page.getByRole('button', { name: 'Sửa 散', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sửa 学', exact: true })).toBeVisible();
});
