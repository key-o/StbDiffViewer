/** @fileoverview STB tag adapter shared XML helpers. Viewer boundary only. */
import {
  getVersionInfo,
  ROOT_ELEMENT_NAMES,
} from '../../common-stb/import/parser/utils/stbVersionDetection.js';

export function localName(element) {
  const name = element?.localName || element?.nodeName || element?.tagName || '';
  const separator = name.indexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

export function directChildren(parent, tagName = null) {
  return Array.from(parent?.childNodes || []).filter(
    (child) => child?.nodeType === 1 && (!tagName || localName(child) === tagName),
  );
}

function allElements(document, tagName) {
  const direct = Array.from(document?.getElementsByTagName?.(tagName) || []);
  if (direct.length) return direct;
  return Array.from(document?.getElementsByTagNameNS?.('*', tagName) || []);
}

export function uniqueById(document, tagName, id, { required = true } = {}) {
  const matches = allElements(document, tagName).filter(
    (element) => String(element.getAttribute?.('id')) === String(id),
  );
  if (matches.length > 1) throw new Error(`${tagName} ID=${id} が複数存在します。`);
  if (matches.length === 0 && required) throw new Error(`${tagName} ID=${id} が見つかりません。`);
  return matches[0] || null;
}

export function readVersion(document) {
  const root = document?.documentElement;
  if (document?.nodeType !== 9 || !ROOT_ELEMENT_NAMES.includes(localName(root)))
    throw new TypeError('ST_BRIDGE Documentが必要です。');
  const info = getVersionInfo(document);
  if (!info.isSupported)
    throw new RangeError(`未対応のST-Bridgeバージョンです: ${String(info.rawVersion)}`);
  return {
    version: info.rawVersion || info.version,
    family: info.version === '2.0.2' ? '2.0.2' : '2.1.x',
  };
}
