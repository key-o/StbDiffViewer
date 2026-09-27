/**
 * @fileoverview 線材数量計算用 context の正規化ヘルパー（Three.js 非依存）。
 */

const LINEAR_MEMBER_CONFIG = Object.freeze({
  Column: {
    stbElementType: 'StbColumn',
    elementsKey: 'columnElements',
    sectionsKey: 'columnSections',
    nodeMode: 'column',
  },
  Post: {
    stbElementType: 'StbPost',
    elementsKey: 'postElements',
    sectionsKey: 'postSections',
    nodeMode: 'column',
  },
  Girder: {
    stbElementType: 'StbGirder',
    elementsKey: 'girderElements',
    sectionsKey: 'girderSections',
    nodeMode: 'horizontal',
  },
  Beam: {
    stbElementType: 'StbBeam',
    elementsKey: 'beamElements',
    sectionsKey: 'beamSections',
    nodeMode: 'horizontal',
  },
  Brace: {
    stbElementType: 'StbBrace',
    elementsKey: 'braceElements',
    sectionsKey: 'braceSections',
    nodeMode: 'horizontal',
  },
  FoundationColumn: {
    stbElementType: 'StbFoundationColumn',
    elementsKey: 'foundationColumnElements',
    sectionsKey: 'foundationColumnSections',
    nodeMode: 'foundation-column',
  },
});

const VIA_NODE_TAG_BY_MEMBER = Object.freeze({
  StbColumn: 'StbColumnViaNode',
  StbPost: 'StbPostViaNode',
  StbGirder: 'StbGirderViaNode',
  StbBeam: 'StbBeamViaNode',
});

const STEEL_SWITCH_TAG_BY_MEMBER = Object.freeze({
  StbGirder: 'StbGirderSteelSwitch',
  StbBeam: 'StbBeamSteelSwitch',
});

const RAW_NUMERIC_ATTRIBUTES = Object.freeze([
  // SRC steel cutback (column/post naming + beam/girder naming)
  'steel_cutback_bottom',
  'steel_cutback_top',
  'steel_cutback_start',
  'steel_cutback_end',
  // 2.0.x/2.1.x column steel switch naming (2.1.0 typo is retained as an alias)
  'steel_switch_height_bottom',
  'steel_switch_height_top',
  'steel_switch_heigth_top',
  // Column/Post concrete fukashi
  'thickness_add_start_X',
  'thickness_add_end_X',
  'thickness_add_start_Y',
  'thickness_add_end_Y',
  // Girder/Beam concrete fukashi
  'thickness_add_top',
  'thickness_add_bottom',
  'thickness_add_right',
  'thickness_add_left',
]);

function normalizeId(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? value : parsed;
}

function elementTagName(element) {
  const name = element?.localName || element?.nodeName || '';
  const separator = name.indexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function directChildElements(parent, tagName) {
  return Array.from(parent?.childNodes || []).filter(
    (child) => child?.nodeType === 1 && elementTagName(child) === tagName,
  );
}

function findElementsByTagName(document, tagName) {
  if (!document || !tagName) return [];

  if (typeof document.getElementsByTagName === 'function') {
    const direct = Array.from(document.getElementsByTagName(tagName) || []);
    if (direct.length > 0) return direct;
  }

  if (typeof document.getElementsByTagNameNS === 'function') {
    const namespaced = Array.from(document.getElementsByTagNameNS('*', tagName) || []);
    if (namespaced.length > 0) return namespaced;
  }

  return [];
}

function readViaNodes(memberNode, stbElementType) {
  const viaTag = VIA_NODE_TAG_BY_MEMBER[stbElementType];
  if (!viaTag) return null;

  const viaElement = directChildElements(memberNode, viaTag)[0];
  if (!viaElement) return null;

  const orderElement = directChildElements(viaElement, 'StbNodeIdOrder')[0];
  const nodeIds = String(orderElement?.textContent || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const offsetByNode = new Map();
  for (const offsetElement of directChildElements(viaElement, 'StbMemberOffsetList')) {
    const idNode = offsetElement.getAttribute?.('id_node');
    if (idNode === null || idNode === undefined || idNode === '') continue;
    offsetByNode.set(String(idNode), {
      offset_X: offsetElement.getAttribute?.('offset_X'),
      offset_Y: offsetElement.getAttribute?.('offset_Y'),
      offset_Z: offsetElement.getAttribute?.('offset_Z'),
    });
  }

  return nodeIds.map((idNode) => ({
    id_node: idNode,
    ...(offsetByNode.get(String(idNode)) || {}),
  }));
}

function readSteelSwitches(memberNode, stbElementType) {
  const switchTag = STEEL_SWITCH_TAG_BY_MEMBER[stbElementType];
  if (!switchTag) return null;

  const switches = directChildElements(memberNode, switchTag).map((switchElement) => ({
    order: switchElement.getAttribute?.('order'),
    distance: switchElement.getAttribute?.('distance'),
  }));
  return switches.length > 0 ? switches : null;
}

function buildElementIndex(document, tagName) {
  const index = new Map();
  for (const node of findElementsByTagName(document, tagName)) {
    const id = node.getAttribute?.('id');
    if (id === null || id === undefined || id === '') continue;
    const key = String(id);
    if (!index.has(key)) index.set(key, node);
  }
  return index;
}

function readLinearMemberOverrides(node, stbElementType) {
  if (!node || !stbElementType) return {};
  const result = {};
  for (const name of RAW_NUMERIC_ATTRIBUTES) {
    const raw = node.getAttribute?.(name);
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    // Preserve an invalid raw value so the quantity calculator can fail closed rather than silently dropping it.
    result[name] = Number.isFinite(value) ? value : raw;
  }
  if (
    result.steel_switch_height_top === undefined &&
    result.steel_switch_heigth_top !== undefined
  ) {
    result.steel_switch_height_top = result.steel_switch_heigth_top;
  }
  const kind = node.getAttribute?.('kind_structure');
  if (kind) result.kind_structure = kind;

  const quantityViaNodes = readViaNodes(node, stbElementType);
  if (quantityViaNodes !== null) result.quantityViaNodes = quantityViaNodes;

  const quantitySteelSwitches = readSteelSwitches(node, stbElementType);
  if (quantitySteelSwitches !== null) result.quantitySteelSwitches = quantitySteelSwitches;
  return result;
}

export function getLinearMemberConfig(elementType) {
  if (!elementType) return null;
  const shortType = String(elementType).replace(/^Stb/, '');
  return LINEAR_MEMBER_CONFIG[shortType] || null;
}

export function getSectionFromMap(sections, sectionId) {
  if (!sections || typeof sections.get !== 'function') return null;
  const normalized = normalizeId(sectionId);
  if (normalized === null) return null;
  return sections.get(normalized) || sections.get(String(sectionId)) || null;
}

/**
 * FoundationColumn は STB 仕様/変換元により専用 map または Column map を参照し得るため、
 * 専用 map → columnSections の順で解決する。
 */
export function resolveFoundationColumnSection(parsedData, sectionId) {
  const primary = getSectionFromMap(parsedData?.foundationColumnSections, sectionId);
  if (primary) return primary;
  return getSectionFromMap(parsedData?.columnSections, sectionId);
}

export function buildLinearMemberContexts(
  parsedData,
  elementType,
  { modelSide = null, revision = null, document = null } = {},
) {
  const config = getLinearMemberConfig(elementType);
  if (!config || !parsedData) return [];

  const elements = parsedData[config.elementsKey];
  if (!Array.isArray(elements)) return [];
  const rawElementsById = buildElementIndex(document, config.stbElementType);
  const overridesFor = (element) =>
    readLinearMemberOverrides(rawElementsById.get(String(element?.id)), config.stbElementType);

  if (config.nodeMode === 'foundation-column') {
    return elements.map((element) => ({
      modelSide,
      revision,
      elementType: config.stbElementType,
      element: {
        ...element,
        ...overridesFor(element),
      },
      nodes: parsedData.nodes || parsedData.nodeMapRaw || new Map(),
      sectionFD: resolveFoundationColumnSection(parsedData, element.id_section_FD),
      sectionWR: resolveFoundationColumnSection(parsedData, element.id_section_WR),
      steelSections: parsedData.steelSections || new Map(),
    }));
  }

  const sections = parsedData[config.sectionsKey];
  return elements.map((element) => ({
    modelSide,
    revision,
    elementType: config.stbElementType,
    element: {
      ...element,
      ...overridesFor(element),
    },
    nodes: parsedData.nodes || parsedData.nodeMapRaw || new Map(),
    section: getSectionFromMap(sections, element.id_section),
    steelSections: parsedData.steelSections || new Map(),
  }));
}

export { LINEAR_MEMBER_CONFIG };
