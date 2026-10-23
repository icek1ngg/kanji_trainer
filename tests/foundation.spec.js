import { test, expect } from '@playwright/test';

test('all routes render, including the unknown-route fallback', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tổng quan');
  const navigation = page.getByRole('navigation');
  for (const title of ['Luyện tập', 'Flashcard', 'Ôn câu sai', 'Kho Kanji', 'Thống kê', 'Cài đặt']) {
    await navigation.getByRole('link', { name: title, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(navigation.getByRole('link', { name: title, exact: true })).toHaveAttribute('aria-current', 'page');
  }
  await page.goto('/#/missing');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Không tìm thấy trang');
  expect(errors).toEqual([]);
});

test('theme persists after refresh and skip link supports keyboard access', async ({ page }) => {
  await page.goto('/');
  const before = await page.locator('html').getAttribute('data-theme');
  await page.getByRole('button', { name: /Chuyển sang giao diện/ }).click();
  const next = before === 'dark' ? 'light' : 'dark';
  await expect(page.locator('html')).toHaveAttribute('data-theme', next);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', next);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Đến nội dung chính' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
});

test('mobile navigation is reachable without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const settings = page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' });
  await settings.scrollIntoViewIfNeeded();
  await settings.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cài đặt');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
