/**
 * 断面・継手名称を比較キー向けに正規化する。
 *
 * STB 出力元による前後空白、大文字小文字、名称中の空白の差を吸収する。
 * @param {*} name - 正規化対象の名称
 * @returns {string} trim・大文字化・空白除去済みの名称
 */
export function normalizeSectionName(name) {
  return name ? String(name).trim().toUpperCase().replace(/\s+/g, '') : '';
}
