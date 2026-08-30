/**
 * @fileoverview 編集モードの XML/DOM 操作ユーティリティ
 *
 * documentA への要素追加で用いるコンテナ確保・XSD sequence 順を保った挿入・id 採番・
 * 構造変更通知など、共有状態に依存しない純粋な文書操作を提供する。
 */

import { eventBus, EditEvents } from '../../../../data/events/index.js';

/**
 * 親要素の直下から指定タグ名の子要素を返す（querySelector は子孫も拾うため使わない）。
 * @param {Element} parent
 * @param {string} tagName
 * @returns {Element|null}
 */
export function findDirectChild(parent, tagName) {
  for (const child of parent.children) {
    if (child.tagName === tagName) return child;
  }
  return null;
}

/** XSD sequence 順を持つ親要素ごとの子要素順序（ST-Bridge 2.1.x XSD 準拠）。新規子はこの順序を保って挿入する。 */
const CHILD_ORDER_BY_PARENT = {
  StbModel: [
    'StbNodes',
    'StbAxes',
    'StbStories',
    'StbMembers',
    'StbSections',
    'StbJoints',
    'StbConnections',
    'StbWeld',
  ],
  StbAxes: ['StbParallelAxes', 'StbArcAxes', 'StbRadialAxes', 'StbDrawingAxes'],
};

/**
 * 子要素を XSD の sequence 順を保って親へ挿入する。順序定義に無い要素や対象外の親では
 * 末尾へ追加する（既存挙動を維持）。StbAxes/StbStories や円弧/放射軸グループを後発で
 * 作成した際に sequence 順を崩してバリデーションエラーになるのを防ぐ。
 * @param {Element} parent
 * @param {Element} child
 */
function insertChildInOrder(parent, child) {
  const order = CHILD_ORDER_BY_PARENT[parent.tagName] || null;
  const targetIndex = order ? order.indexOf(child.tagName) : -1;
  if (targetIndex < 0) {
    parent.appendChild(child);
    return;
  }
  // 自分より後ろに並ぶべき最初の既存子の前に挿入する。
  for (const existing of parent.children) {
    const existingIndex = order.indexOf(existing.tagName);
    if (existingIndex > targetIndex) {
      parent.insertBefore(child, existing);
      return;
    }
  }
  parent.appendChild(child);
}

/**
 * StbModel 直下からコンテナパスを辿り、無ければ生成して末端コンテナを返す。
 * 既定名前空間（xmlns）を親から継承するため createElementNS を用いる。
 * @param {Document} doc
 * @param {string[]} pathTags - 例 ['StbMembers', 'StbColumns']
 * @returns {Element|null} 末端コンテナ要素（StbModel が無い場合は null）
 */
export function ensureContainer(doc, pathTags) {
  let parent = doc.querySelector('StbModel');
  if (!parent) return null;

  const ns = parent.namespaceURI;
  for (const tag of pathTags) {
    let child = findDirectChild(parent, tag);
    if (!child) {
      child = ns ? doc.createElementNS(ns, tag) : doc.createElement(tag);
      insertChildInOrder(parent, child);
    }
    parent = child;
  }
  return parent;
}

/** 通り芯グループ（StbParallelAxes）を新設する際の既定属性。SS7→STB 出力と同じ角度を用いる。 */
const AXIS_GROUP_DEFAULTS = {
  X: { angle: '90.0' },
  Y: { angle: '0.0' },
};

/**
 * 軸の所属グループ（StbAxes > containerTag[group_name=group]）を辿り、無ければ生成して返す。
 * 返したグループ要素が個々の軸要素（StbParallelAxis 等）を追加する直接の親となる。
 * グループ新設時は def に応じたグループ属性（StbParallelAxes は角度、円弧/放射は中心/角度）を設定する。
 * @param {Document} doc
 * @param {{axisContainerTag: string, groupAttrFields?: Array<{field:string,attr:string,default:string}>}} def
 * @param {Object<string,string>} attrs - 入力属性（group=グループ名、グループ属性フィールドを含む）
 * @returns {Element|null} 軸グループ要素（StbModel が無い場合は null）
 */
export function ensureAxisGroup(doc, def, attrs) {
  const model = doc.querySelector('StbModel');
  if (!model) return null;

  const group = String(attrs.group ?? def.defaults?.group ?? '').trim();
  const ns = model.namespaceURI;
  const create = (tag) => (ns ? doc.createElementNS(ns, tag) : doc.createElement(tag));

  let axes = findDirectChild(model, 'StbAxes');
  if (!axes) {
    axes = create('StbAxes');
    insertChildInOrder(model, axes);
  }

  for (const child of axes.children) {
    if (child.tagName === def.axisContainerTag && child.getAttribute('group_name') === group) {
      return child;
    }
  }

  const groupEl = create(def.axisContainerTag);
  groupEl.setAttribute('group_name', group);
  if (def.axisContainerTag === 'StbParallelAxes') {
    // 平行軸グループは中心 0,0・角度は X/Y で既定（SS7→STB 出力と同じ）
    groupEl.setAttribute('X', '0.0');
    groupEl.setAttribute('Y', '0.0');
    groupEl.setAttribute('angle', (AXIS_GROUP_DEFAULTS[group] || AXIS_GROUP_DEFAULTS.Y).angle);
  } else {
    // 円弧/放射軸グループは入力フィールド（中心・角度）からグループ属性を設定する
    for (const { field, attr, default: dflt } of def.groupAttrFields || []) {
      const raw = attrs[field];
      groupEl.setAttribute(attr, String(raw === undefined || raw === '' ? dflt : raw));
    }
  }
  insertChildInOrder(axes, groupEl);
  return groupEl;
}

/**
 * 面材の節点列を string[] に正規化する。配列・スペース区切り文字列の双方を受け付け、
 * 空要素を除去する（順序は保持する）。
 * @param {string[]|string|undefined} src
 * @returns {string[]}
 */
export function normalizeNodeIds(src) {
  const arr = Array.isArray(src)
    ? src
    : String(src ?? '')
        .trim()
        .split(/\s+/);
  return arr.map((v) => String(v).trim()).filter(Boolean);
}

/**
 * 指定タグ名の既存IDの最大値＋1を新規IDとして採番する。
 * 階・通り芯（global=true）は他要素と同じ id 空間で一意にする必要があるため、
 * モデル全体（全要素）の最大 id を基準にする（疎な id を持つ階・通り芯が部材 id と衝突するのを防ぐ）。
 * @param {Document} doc
 * @param {string} tagName
 * @param {{global?: boolean}} [options]
 * @returns {string}
 */
export function generateNextId(doc, tagName, { global = false } = {}) {
  let maxId = 0;
  const elements = global ? doc.querySelectorAll('[id]') : doc.querySelectorAll(tagName);
  for (const el of elements) {
    const id = parseInt(el.getAttribute('id'), 10);
    if (Number.isFinite(id) && id > maxId) maxId = id;
  }
  return String(maxId + 1);
}

/**
 * StbSections 直下の全断面で重複しない次の id を採番する。
 * 断面 id は部材の id_section から参照されるため、断面種別をまたいで一意にする。
 * @param {Element} sectionsContainer - StbSections 要素
 * @returns {string}
 */
export function generateNextSectionId(sectionsContainer) {
  let maxId = 0;
  // 直下だけでなく全子孫の id を走査する（型コンテナで入れ子になる版・実装に備える）。
  for (const el of sectionsContainer.querySelectorAll('*')) {
    const id = parseInt(el.getAttribute('id'), 10);
    if (Number.isFinite(id) && id > maxId) maxId = id;
  }
  return String(maxId + 1);
}

/**
 * 要素の追加・削除後に「型単位の再抽出 → 再比較 → 再描画」パイプラインを起動する。
 * 属性変更ではなく要素構成の変化のため、attributeName/oldValue/newValue は null で発行する。
 * @param {string} elementType - タグ名から 'Stb' を除いたタイプ
 * @param {string} elementId - 追加・削除した要素の id
 */
export function emitStructuralChange(elementType, elementId) {
  eventBus.emit(EditEvents.ATTRIBUTE_CHANGED, {
    elementType,
    elementId,
    attributeName: null,
    oldValue: null,
    newValue: null,
    modelSource: 'modelA',
    timestamp: Date.now(),
  });
}
