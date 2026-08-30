/**
 * ブラウザー配信時はアプリ基準、相対URLを解決できない環境ではモジュール基準で
 * 実行時アセットURLを組み立てる。
 *
 * @param {string} appRelativePath - document.baseURI からの相対パス
 * @param {string} moduleRelativePath - 呼び出し元モジュールからの相対パス
 * @param {string} moduleUrl - 呼び出し元の import.meta.url
 * @param {string|null|undefined} [documentBaseUri]
 * @returns {string}
 */
export function resolveRuntimeAssetUrl(
  appRelativePath,
  moduleRelativePath,
  moduleUrl,
  documentBaseUri = typeof document !== 'undefined' ? document.baseURI : null,
) {
  if (documentBaseUri) {
    try {
      return new URL(appRelativePath, documentBaseUri).href;
    } catch {
      // jsdom の about:blank などではモジュール相対URLへフォールバックする。
    }
  }
  return new URL(moduleRelativePath, moduleUrl).href;
}
