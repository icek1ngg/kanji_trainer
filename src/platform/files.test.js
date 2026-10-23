import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ isTauri: vi.fn(), save: vi.fn(), writeFile: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: mocks.writeFile }));
import { saveBytes, saveText } from './files.js';

beforeEach(() => { vi.resetAllMocks(); mocks.isTauri.mockReturnValue(true); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('desktop and browser file export', () => {
  it('saves Unicode text to only the path chosen by the user', async () => {
    mocks.save.mockResolvedValue('D:/exports/kanji.json');
    await expect(saveText('散: TÁN/TẢN', 'kanji.json')).resolves.toMatchObject({ saved: true, native: true });
    expect(mocks.save).toHaveBeenCalledWith({ defaultPath: 'kanji.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    const [path, bytes] = mocks.writeFile.mock.calls[0];
    expect(path).toBe('D:/exports/kanji.json');
    expect(new TextDecoder().decode(bytes)).toBe('散: TÁN/TẢN');
  });

  it('does not write or report success when the native picker is cancelled', async () => {
    mocks.save.mockResolvedValue(null);
    await expect(saveBytes(new Uint8Array([1, 2]), 'kanji.xlsx')).resolves.toEqual({ saved: false, cancelled: true, native: true });
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('preserves Excel byte slices without including bytes outside the view', async () => {
    mocks.save.mockResolvedValue('D:/exports/kanji.xlsx');
    await saveBytes(new Uint8Array([9, 1, 2, 9]).subarray(1, 3), 'kanji.xlsx');
    expect([...mocks.writeFile.mock.calls[0][1]]).toEqual([1, 2]);
  });

  it('exposes a failed native write to the calling UI instead of false success', async () => {
    mocks.save.mockResolvedValue('D:/exports/kanji.xlsx');
    mocks.writeFile.mockRejectedValue(new Error('permission denied'));
    await expect(saveBytes(new Uint8Array([1]), 'kanji.xlsx')).rejects.toThrow('permission denied');
  });

  it('retains ordinary browser downloads without invoking native plugins', async () => {
    vi.useFakeTimers();
    mocks.isTauri.mockReturnValue(false);
    const anchor = { style: {}, click: vi.fn(), remove: vi.fn() };
    const appendChild = vi.fn();
    vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild } });
    vi.stubGlobal('window', { setTimeout });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL });
    await expect(saveText('Âm Hán Việt', 'kanji.json')).resolves.toMatchObject({ saved: true, native: false });
    expect(anchor.download).toBe('kanji.json');
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });
});
