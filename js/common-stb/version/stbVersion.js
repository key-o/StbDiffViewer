/**
 * @fileoverview STBバージョン文字列の正規化ユーティリティ（単一情報源）
 *
 * バージョン正規化・ファイル名トークン変換・サポート判定を一元管理します。
 * UI・コンバーター・エクスポーター・CLIはすべて本モジュールを使用してください。
 *
 * 注意: `common-stb/import/`（STB読み込みカーネル）はアプリ非依存の
 * サブプロジェクトであり外部モジュールをimportできないため（CLAUDE.md 例外E4）、
 * カーネル内の `stbVersionDetection.js` は本モジュールを参照しません。
 * 判定ロジックを変更する場合は両方の整合を保つこと。
 *
 * @module common/stb/version/stbVersion
 */

/** サポートするSTBバージョン（正規形） */
export const SUPPORTED_STB_VERSIONS = ['2.0.2', '2.1.0', '2.1.1'];

/**
 * バージョン文字列を正規形（'2.0.2' | '2.1.0' | '2.1.1'）に正規化する。
 *
 * '202' / 'v202' / '2.0' / '2.0.x' → '2.0.2'
 * '211' / 'v211' / '2.1.1'          → '2.1.1'
 * '210' / 'v210' / '2.1' / '2.1.x'  → '2.1.0'
 * 未知の形式はトリム済みの入力をそのまま返す。
 * @param {string|null|undefined} version - バージョン文字列
 * @returns {string|null} 正規化されたバージョン（入力が空ならnull）
 */
export function normalizeStbVersion(version) {
  if (version === null || version === undefined || String(version).trim() === '') {
    return null;
  }
  const v = String(version).trim().toLowerCase().replace(/^v/, '');
  if (v === '202' || v === '2.0' || v.startsWith('2.0.')) return '2.0.2';
  if (v === '211' || v === '2.1.1' || v.startsWith('2.1.1.')) return '2.1.1';
  if (v === '210' || v === '2.1' || v.startsWith('2.1.')) return '2.1.0';
  return v;
}

/**
 * 正規化後のバージョンが 2.1.x 系かを判定する。
 * @param {string|null|undefined} version - バージョン文字列（未正規化可）
 * @returns {boolean} 2.1.0 または 2.1.1 ならtrue
 */
export function isStb21x(version) {
  const normalized = normalizeStbVersion(version);
  return normalized === '2.1.0' || normalized === '2.1.1';
}

/**
 * サポート対象バージョンかを判定する。
 * @param {string|null|undefined} version - バージョン文字列（未正規化可）
 * @returns {boolean} サポート対象ならtrue
 */
export function isSupportedStbVersion(version) {
  return SUPPORTED_STB_VERSIONS.includes(normalizeStbVersion(version));
}

/**
 * バージョン文字列をファイル名用トークン（'v202' 等）に変換する。
 * @param {string|null|undefined} version - バージョン文字列
 * @returns {string} ファイル名用トークン（入力が空なら空文字）
 */
export function toStbVersionFilenameToken(version) {
  const normalized = normalizeStbVersion(version);
  if (!normalized) return '';
  if (SUPPORTED_STB_VERSIONS.includes(normalized)) {
    return `v${normalized.replace(/\./g, '')}`;
  }
  const digits = normalized.replace(/\D/g, '');
  return digits ? `v${digits}` : '';
}
