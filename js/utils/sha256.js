/** @fileoverview Worker転送前のバイト列やDocument snapshotを識別する。 */
export async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('SHA-256にはWeb Crypto対応の安全なコンテキストが必要です。');
  }
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
