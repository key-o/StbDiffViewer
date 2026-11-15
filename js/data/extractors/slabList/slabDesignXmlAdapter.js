/**
 * @fileoverview 「スラブの設計」XML専用の非破壊・read-only補助facts抽出。
 * ST-Bridge形式や任意の計算ソフトXMLに適用しない。
 * XML解析器はブラウザDOMParserまたはテスト用DIで供給する。
 */

export const SLAB_DESIGN_XML_MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 10000;
const MAX_XML_DEPTH = 128;
const MAX_XML_NODES = 100000;
const POSITIONS = Object.freeze(['短辺端部', '短辺中央', '長辺端部', '長辺中央']);
const NUMERIC_FIELDS = Object.freeze([
  't',
  'lx',
  'ly',
  'dt',
  'w',
  '応力の割増率',
  '変位の割増率',
  'τmax',
  'δ',
  'δ_lx',
  't_lx',
]);
const DESIGN_FIELDS = Object.freeze(['M', 'at', 'Q', '検定比']);
const TEXT_FIELDS = Object.freeze(['Name', '支持条件', '荷重種別', '備考']);
const KNOWN_CHILDREN = new Set([
  ...NUMERIC_FIELDS,
  ...TEXT_FIELDS,
  'Place',
  'コンクリート材料',
  '鉄筋材料',
]);

function issue(code, severity, path, message) {
  return { code, severity, path, message };
}

function children(element, name) {
  return Array.from(element?.childNodes || []).filter(
    (node) => node.nodeType === 1 && (!name || node.nodeName === name),
  );
}

function first(element, name) {
  return children(element, name)[0] || null;
}

function attributes(element) {
  return Object.fromEntries(
    Array.from(element?.attributes || []).map((attr) => [attr.name, attr.value]),
  );
}

function rawText(element) {
  return element ? (element.textContent ?? '') : null;
}

function textField(element) {
  const raw = rawText(element);
  return { raw, status: raw == null || raw.trim() === '' ? 'MISSING' : 'VALID' };
}

function numberField(element, path, diagnostics) {
  const field = textField(element);
  // 単位はソフトの正式仕様未確認。数値の大小から単位・意味を推定しない。
  const result = { raw: field.raw, value: null, status: field.status, unit: null };
  if (field.status === 'MISSING') return result;
  const literal = field.raw.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(literal)) {
    result.status = 'INVALID';
  } else {
    const value = Number(literal);
    if (Number.isFinite(value)) result.value = value;
    else result.status = 'INVALID';
  }
  if (result.status === 'INVALID') {
    diagnostics.push(
      issue('INVALID_NUMBER', 'warning', path, `数値として解釈できません: ${field.raw}`),
    );
  }
  return result;
}

// ソースのchild/属性/textの順序と値を保持。編集可能なDOMは外部公開しない。
function sourceNode(node) {
  switch (node.nodeType) {
    case 1:
      return {
        type: 'element',
        name: node.nodeName,
        attributes: attributes(node),
        children: Array.from(node.childNodes || [])
          .map(sourceNode)
          .filter(Boolean),
      };
    case 3:
      return { type: 'text', value: node.nodeValue };
    case 4:
      return { type: 'cdata', value: node.nodeValue };
    case 8:
      return { type: 'comment', value: node.nodeValue };
    case 7:
      return { type: 'processingInstruction', name: node.nodeName, value: node.nodeValue };
    default:
      return null;
  }
}

function freezeTree(node) {
  if (!node || typeof node !== 'object') return node;
  Object.values(node).forEach(freezeTree);
  return Object.freeze(node);
}

function parsePlace(place, path, diagnostics) {
  const name = place.getAttribute('Name');
  const design = Object.fromEntries(
    DESIGN_FIELDS.map((key) => [
      key,
      numberField(first(place, key), `${path}/${key}`, diagnostics),
    ]),
  );
  return {
    name,
    attributes: attributes(place),
    design,
    bars: {
      top: textField(first(place, '上端配筋')),
      bottom: textField(first(place, '下端配筋')),
    },
  };
}

function parseRecord(record, index, diagnostics) {
  const path = `Record[${index}]`;
  const fields = Object.fromEntries(
    NUMERIC_FIELDS.map((key) => [
      key,
      numberField(first(record, key), `${path}/${key}`, diagnostics),
    ]),
  );
  for (const key of TEXT_FIELDS) fields[key] = textField(first(record, key));
  const support = first(record, '支持条件');
  const load = first(record, '荷重種別');
  const concrete = first(record, 'コンクリート材料');
  const steel = first(record, '鉄筋材料');
  const places = children(record, 'Place').map((place, placeIndex) =>
    parsePlace(place, `${path}/Place[${placeIndex}]`, diagnostics),
  );
  for (const position of POSITIONS) {
    if (!places.some((place) => place.name === position)) {
      diagnostics.push(issue('MISSING_PLACE', 'warning', path, `位置 ${position} がありません`));
    }
    if (places.filter((place) => place.name === position).length > 1) {
      diagnostics.push(
        issue('DUPLICATE_PLACE', 'warning', path, `位置 ${position} が重複しています`),
      );
    }
  }
  for (const key of ['Name', 't']) {
    if (fields[key].status === 'MISSING') {
      diagnostics.push(issue('MISSING_FIELD', 'warning', `${path}/${key}`, `${key} が未入力です`));
    }
  }
  const materials = {
    concrete: {
      name: textField(concrete),
      attributes: attributes(concrete),
      gamma: numberField(
        concrete?.getAttributeNode?.('γ') && { textContent: concrete.getAttribute('γ') },
        `${path}/コンクリート材料/@γ`,
        diagnostics,
      ),
      fs: numberField(
        concrete?.getAttributeNode?.('fs') && { textContent: concrete.getAttribute('fs') },
        `${path}/コンクリート材料/@fs`,
        diagnostics,
      ),
    },
    steel: { attributes: attributes(steel) },
  };
  return {
    index,
    name: fields.Name.raw,
    fields,
    conditions: { support: attributes(support), load: attributes(load) },
    places,
    materials,
    source: {
      recordIndex: index,
      attributes: attributes(record),
      unknownChildren: children(record)
        .filter((node) => !KNOWN_CHILDREN.has(node.nodeName))
        .map((node) => node.nodeName),
    },
  };
}

/**
 * @param {string} xmlText UTF-8デコード済みXML文字列
 * @param {{ Parser?: typeof DOMParser, maxBytes?: number }} options
 * @returns {{ ok: boolean, records: object[], diagnostics: object[], source: object|null }}
 */
export function parseSlabDesignXml(xmlText, options = {}) {
  const diagnostics = [];
  const rejected = (code, message) => ({
    ok: false,
    records: [],
    diagnostics: [issue(code, 'error', '$', message)],
    source: null,
  });
  if (typeof xmlText !== 'string')
    return rejected('INVALID_INPUT', 'XMLは文字列で指定してください');
  const maxBytes = options.maxBytes ?? SLAB_DESIGN_XML_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return rejected('INVALID_LIMIT', 'XML読込サイズ上限が不正です');
  }
  if (new TextEncoder().encode(xmlText).length > maxBytes) {
    return rejected('XML_TOO_LARGE', `XMLの上限 ${maxBytes} bytes を超えています`);
  }
  if (
    /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xmlText) ||
    /<\?xml-stylesheet\b/i.test(xmlText) ||
    /<\s*\w+:include\b/i.test(xmlText)
  ) {
    return rejected('UNSAFE_XML', 'DOCTYPE/ENTITY/外部参照は許可しません');
  }
  const Parser = options.Parser ?? globalThis.DOMParser;
  if (!Parser) return rejected('PARSER_UNAVAILABLE', 'XML解析器を利用できません');
  let document;
  const parseErrors = [];
  try {
    document = new Parser({
      errorHandler: {
        warning: (message) => parseErrors.push(message),
        error: (message) => parseErrors.push(message),
        fatalError: (message) => parseErrors.push(message),
      },
    }).parseFromString(xmlText, 'application/xml');
  } catch (error) {
    return rejected('MALFORMED_XML', String(error?.message || error));
  }
  if (
    parseErrors.length ||
    !document?.documentElement ||
    document.documentElement.nodeName === 'parsererror'
  ) {
    return rejected('MALFORMED_XML', `XML構文が不正です: ${parseErrors[0] || 'parsererror'}`);
  }
  const root = document.documentElement;
  if (root.nodeName !== 'スラブの設計') {
    return rejected('INVALID_ROOT', `対応しないルート要素: ${root.nodeName}`);
  }
  // 外部参照のほか、深いネスト/大量ノードがsourceTree生成を枯渇させる入力を拒否する。
  const pending = [{ node: root, depth: 1 }];
  let nodeCount = 0;
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (++nodeCount > MAX_XML_NODES || depth > MAX_XML_DEPTH) {
      return rejected('XML_COMPLEXITY_LIMIT', 'XMLのノード数またはネストが上限を超えています');
    }
    if (
      node.nodeType === 1 &&
      node.namespaceURI === 'http://www.w3.org/2001/XInclude' &&
      node.localName === 'include'
    ) {
      return rejected('UNSAFE_XML', 'XInclude外部参照は許可しません');
    }
    for (const child of Array.from(node.childNodes || [])) {
      pending.push({ node: child, depth: depth + 1 });
    }
  }
  const recordElements = children(root, 'Record');
  if (recordElements.length > MAX_RECORDS) {
    return rejected('TOO_MANY_RECORDS', `Record数が ${MAX_RECORDS} を超えています`);
  }
  const records = recordElements.map((record, index) => parseRecord(record, index, diagnostics));
  const seen = new Map();
  for (const record of records) {
    const name = record.name?.trim();
    if (!name || name === '無題') continue;
    if (seen.has(name))
      diagnostics.push(
        issue(
          'DUPLICATE_NAME',
          'warning',
          `Record[${record.index}]/Name`,
          `Name ${name} が Record[${seen.get(name)}] と重複しています`,
        ),
      );
    else seen.set(name, record.index);
  }
  const source = freezeTree({ originalXml: xmlText, root: sourceNode(root) });
  return { ok: true, records, diagnostics, source };
}
