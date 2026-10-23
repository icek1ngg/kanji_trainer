import { test, expect } from '@playwright/test';

test('Kanji and history stores survive a browser refresh without internet', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { openDatabase } = await import('/src/data/database.js');
    const { createKanjiRepository } = await import('/src/data/kanjiRepository.js');
    const db = await openDatabase();
    await createKanjiRepository(db).add({ id: 'browser-kanji', kanji: '散', hanViet: ['TÁN', 'TẢN'] });
    const tx = db.transaction(['sessions', 'attempts'], 'readwrite');
    await tx.objectStore('sessions').add({ id: 'browser-session', createdAt: '2026-10-21T00:00:00.000Z' });
    await tx.objectStore('attempts').add({ id: 'browser-attempt', sessionId: 'browser-session', kanjiId: 'browser-kanji', createdAt: '2026-10-21T00:00:00.000Z' });
    await tx.done;
    db.close();
  });
  await page.reload();
  // The installed local server supplies assets; storage itself requires no network.
  await context.setOffline(true);
  const result = await page.evaluate(async () => {
    const { openDatabase } = await import('/src/data/database.js');
    const db = await openDatabase();
    const result = {
      kanji: await db.get('kanji', 'browser-kanji'),
      session: await db.get('sessions', 'browser-session'),
      attempt: await db.get('attempts', 'browser-attempt'),
    };
    db.close();
    return result;
  });
  expect(result.kanji.hanViet).toEqual(['TÁN', 'TẢN']);
  expect(result.session.id).toBe('browser-session');
  expect(result.attempt.kanjiId).toBe('browser-kanji');
});

test('unavailable storage shows a recoverable Vietnamese error and preserves navigation', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
  await page.goto('/');
  await expect(page.locator('.storage-notice')).toContainText('Không thể mở dữ liệu trên thiết bị');
  await page.getByRole('button', { name: 'Thử kết nối lại' }).click();
  await expect(page.locator('.storage-notice')).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Kho Kanji' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kho Kanji');
});
