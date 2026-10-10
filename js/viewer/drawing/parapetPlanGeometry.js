/** @fileoverview ST-Bridge StbParapet の構造平面図外形を原本DOMから解決する。 */

function localName(element) {
  const name = element?.localName || element?.nodeName || '';
  const separator = name.indexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function childElements(root) {
  return Array.from(root?.childNodes || []).filter((child) => child?.nodeType === 1);
}

function numberAttr(element, name) {
  const raw = element?.getAttribute?.(name);
  if (raw == null || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`PARAPET_ATTRIBUTE_INVALID:${name}=${raw}`);
  return value;
}

function nodeXY(nodes, id) {
  const node =
    nodes instanceof Map ? nodes.get(id) || nodes.get(String(id)) || nodes.get(Number(id)) : null;
  const x = Number(node?.x);
  const y = Number(node?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`PARAPET_NODE_NOT_FOUND:${id}`);
  return [x, y];
}

const sectionIndexCache = new WeakMap();

function parapetSectionsById(document) {
  let index = sectionIndexCache.get(document);
  if (!index) {
    index = new Map();
    for (const el of Array.from(document.getElementsByTagName('*'))) {
      if (localName(el) !== 'StbSecParapet_RC') continue;
      const id = el.getAttribute('id');
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(el);
    }
    sectionIndexCache.set(document, index);
  }
  return index;
}

/** I型(アゴなし)断面の壁厚t_Tを返す。L/T型はアゴ寸法が平面外形に効くためfail-closed。 */
export function resolveParapetThickness(document, sectionId) {
  const sections = parapetSectionsById(document).get(sectionId) || [];
  if (sections.length !== 1) {
    throw new Error(
      sections.length === 0
        ? `PARAPET_SECTION_NOT_FOUND:${sectionId}`
        : `PARAPET_SECTION_AMBIGUOUS:${sectionId}`,
    );
  }
  const figures = childElements(sections[0]).filter(
    (el) => localName(el) === 'StbSecFigureParapet_RC',
  );
  if (figures.length !== 1) throw new Error('PARAPET_SECTION_FIGURE_UNRESOLVED');
  const shapes = childElements(figures[0]);
  if (shapes.length !== 1) throw new Error('PARAPET_SECTION_SHAPE_AMBIGUOUS');
  const shapeName = localName(shapes[0]);
  if (shapeName !== 'StbSecParapet_RC_TypeI') {
    throw new Error(`PARAPET_SECTION_SHAPE_UNSUPPORTED:${shapeName}`);
  }
  const thickness = numberAttr(shapes[0], 't_T');
  if (!(thickness > 0)) throw new Error('PARAPET_THICKNESS_INVALID');
  return thickness;
}

/**
 * パラペット平面外形(矩形)を返す。
 * 基準線は始端→終端節点。offsetは正側を左とし、壁厚は基準線中央に振り分ける。
 */
export function resolveParapetPlanGeometry({ document, member, nodes } = {}) {
  if (!document || !member || !(nodes instanceof Map)) {
    throw new TypeError('Parapet plan geometryにはdocument/member/nodesが必要です。');
  }
  const sectionId = String(member.getAttribute('id_section') || '').trim();
  if (!sectionId) throw new Error('PARAPET_SECTION_ID_REQUIRED');
  const thickness = resolveParapetThickness(document, sectionId);

  const startId = String(member.getAttribute('id_node_start') || '').trim();
  const endId = String(member.getAttribute('id_node_end') || '').trim();
  if (!startId || !endId) throw new Error('PARAPET_NODE_REQUIRED');
  const [sx, sy] = nodeXY(nodes, startId);
  const [ex, ey] = nodeXY(nodes, endId);
  const offset = numberAttr(member, 'offset');

  const length = Math.hypot(ex - sx, ey - sy);
  if (!(length > 1e-9)) throw new Error('PARAPET_PLAN_AXIS_ZERO_LENGTH');
  const ux = (ex - sx) / length;
  const uy = (ey - sy) / length;
  const leftX = -uy;
  const leftY = ux;
  const half = thickness / 2;
  const cs = [sx + leftX * offset, sy + leftY * offset];
  const ce = [ex + leftX * offset, ey + leftY * offset];
  const points = [
    [cs[0] + leftX * half, cs[1] + leftY * half],
    [ce[0] + leftX * half, ce[1] + leftY * half],
    [ce[0] - leftX * half, ce[1] - leftY * half],
    [cs[0] - leftX * half, cs[1] - leftY * half],
  ].map((point) => Object.freeze(point));

  return Object.freeze({
    points: Object.freeze(points),
    thickness,
    memberAxisModel: Object.freeze({
      kind: 'straight-member-axis',
      start: Object.freeze(cs),
      end: Object.freeze(ce),
      units: 'mm',
    }),
  });
}
