import { isTauri } from '@tauri-apps/api/core';

/**
 * Return true when the frontend is hosted by the Tauri webview.
 *
 * The browser build still imports this module, so the check deliberately does
 * not touch any plugin API until a native save is actually requested.
 */
export function isDesktopRuntime() {
  try {
    return isTauri();
  } catch {
    return Boolean(globalThis?.isTauri || globalThis?.__TAURI_INTERNALS__);
  }
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  throw new TypeError('File contents must be text or bytes.');
}

function extensionOf(fileName = '') {
  const match = String(fileName).toLowerCase().match(/\.([a-z0-9]+)$/u);
  return match?.[1] || '';
}

function browserDownload(bytes, fileName, mimeType) {
  const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Keep the browser's existing download behavior while releasing the object
  // URL once the navigation has been queued.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Save bytes through a native save dialog in Tauri, or through the browser's
 * download anchor when the same React app is served on the web.
 *
 * The Tauri imports are intentionally dynamic. This keeps the ordinary browser
 * bundle independent of the native plugins while allowing the desktop build to
 * request a user-selected path and write only that path.
 *
 * @returns {{ saved: boolean, cancelled: boolean, native: boolean, path?: string }}
 */
export async function saveBytes(value, fileName, mimeType = 'application/octet-stream') {
  const bytes = asBytes(value);
  if (!isDesktopRuntime()) {
    browserDownload(bytes, fileName, mimeType);
    return { saved: true, cancelled: false, native: false };
  }

  const [{ save }, { writeFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const extension = extensionOf(fileName);
  const path = await save({
    defaultPath: fileName,
    ...(extension ? { filters: [{ name: extension.toUpperCase(), extensions: [extension] }] } : {}),
  });
  if (!path) return { saved: false, cancelled: true, native: true };

  // The dialog plugin grants a temporary scope for the path chosen by the
  // user. No app-wide directory or home-directory write scope is requested.
  await writeFile(path, bytes);
  return { saved: true, cancelled: false, native: true, path };
}

export async function saveText(text, fileName, mimeType = 'text/plain;charset=utf-8') {
  return saveBytes(new TextEncoder().encode(String(text)), fileName, mimeType);
}

