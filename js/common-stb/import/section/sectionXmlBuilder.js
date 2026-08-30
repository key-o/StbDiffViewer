/**
 * @fileoverview スキーマ駆動 断面 XML ビルダー
 *
 * SectionBuilderForm の formState と XML Element の相互変換を行う。
 * id 採番・StbSections への追加は EditMode 側の責務とする。
 *
 * @module common-stb/import/section/sectionXmlBuilder
 */

import { getElementAttributes } from '../parser/jsonSchemaLoader.js';

/**
 * @typedef {Object} SectionFormState
 * @property {string} elementName
 * @property {Object<string, string>} [attrs]
 * @property {SectionFormState[]} [children]
 */

/**
 * formState から DOM 要素ツリーを構築する（id は付与しない）。
 * fixed（const）属性はスキーマ値を優先して自動補完する。
 */
export function buildSectionElement(doc, formState, ns = undefined) {
  if (!doc) throw new Error('buildSectionElement: doc が必要です');
  if (!formState || !formState.elementName) {
    throw new Error('buildSectionElement: formState.elementName が必要です');
  }

  const namespace = ns !== undefined ? ns : (doc.documentElement?.namespaceURI ?? null);
  const element = namespace
    ? doc.createElementNS(namespace, formState.elementName)
    : doc.createElement(formState.elementName);

  const attrMap = getElementAttributes(formState.elementName);
  const fixedNames = new Set();
  if (attrMap) {
    for (const [name, def] of attrMap) {
      if (def.fixed !== null && def.fixed !== undefined) {
        element.setAttribute(name, String(def.fixed));
        fixedNames.add(name);
      }
    }
  }

  for (const [name, value] of Object.entries(formState.attrs || {})) {
    if (fixedNames.has(name)) continue;
    if (value === undefined || value === null || String(value).trim() === '') continue;
    element.setAttribute(name, String(value));
  }

  for (const child of formState.children || []) {
    element.appendChild(buildSectionElement(doc, child, namespace));
  }

  return element;
}

/**
 * 既存の断面 Element を SectionBuilderForm が扱う formState に変換する。
 * コピー作成用途では id/guid を引き継がない。その他の属性と子要素構成はそのまま保持する。
 *
 * @param {Element} element
 * @param {{skipAttributes?: Set<string>|string[]}} [options]
 * @returns {SectionFormState}
 */
export function sectionElementToFormState(element, options = {}) {
  if (!element?.tagName) throw new Error('sectionElementToFormState: element が必要です');

  const skip =
    options.skipAttributes instanceof Set
      ? options.skipAttributes
      : new Set(options.skipAttributes || ['id', 'guid']);
  const attrs = {};
  for (const attr of Array.from(element.attributes || [])) {
    if (skip.has(attr.name)) continue;
    attrs[attr.name] = attr.value;
  }

  const children = Array.from(element.children || []).map((child) =>
    sectionElementToFormState(child, { skipAttributes: skip }),
  );

  return {
    elementName: element.tagName,
    attrs,
    children,
  };
}
