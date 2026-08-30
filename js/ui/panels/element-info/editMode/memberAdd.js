/**
 * @fileoverview 新規部材の配置（Phase 6）
 *
 * 部材・面材・階・通り芯・軸の新規追加と、その XML 定義テーブルを提供する。
 * DOM 操作は `domHelpers`、履歴通知は `editHistory` へ委譲する。
 */

import { detectStbVersion } from '../../../../common-stb/import/parser/utils/stbVersionDetection.js';
import { getState } from '../../../../data/state/globalState.js';
import { showSuccess } from '../../../common/toast.js';
import {
  ensureContainer,
  ensureAxisGroup,
  generateNextId,
  normalizeNodeIds,
  emitStructuralChange,
} from './domHelpers.js';
import { updateEditingSummary } from './editHistory.js';
import { getModifications } from './editState.js';

/**
 * 新規部材タイプごとの XML 定義。
 * - tagName: STB要素タグ名
 * - container: StbModel 直下からのコンテナパス（無ければ生成する）
 * - required: 必須属性名（未指定は追加を拒否）
 * - hasName: name 属性を持つ要素か（StbNode は持たない）。STB 2.0.x では name が
 *   XSD 必須のため、addNewMember が未入力時に自動採番する判定に用いる。
 * - nodeList: 面材（節点列を StbNodeIdOrder 子要素で持つ）か
 * - defaults: 省略時に補完する属性のデフォルト値
 * @type {Object<string, {tagName: string, container: string[], required: string[], hasName?: boolean, nodeList?: boolean, defaults: Object<string,string>}>}
 */
const NEW_MEMBER_DEFINITIONS = {
  Node: {
    tagName: 'StbNode',
    container: ['StbNodes'],
    required: ['X', 'Y', 'Z'],
    defaults: { kind: 'ON_GIRDER' },
  },
  Column: {
    tagName: 'StbColumn',
    container: ['StbMembers', 'StbColumns'],
    required: ['id_node_bottom', 'id_node_top', 'id_section'],
    hasName: true,
    defaults: { kind_structure: 'S', rotate: '0' },
  },
  Post: {
    tagName: 'StbPost',
    container: ['StbMembers', 'StbPosts'],
    required: ['id_node_bottom', 'id_node_top', 'id_section'],
    hasName: true,
    defaults: { kind_structure: 'S', rotate: '0' },
  },
  Girder: {
    tagName: 'StbGirder',
    container: ['StbMembers', 'StbGirders'],
    required: ['id_node_start', 'id_node_end', 'id_section'],
    hasName: true,
    defaults: { kind_structure: 'S', rotate: '0' },
  },
  Beam: {
    tagName: 'StbBeam',
    container: ['StbMembers', 'StbBeams'],
    required: ['id_node_start', 'id_node_end', 'id_section'],
    hasName: true,
    defaults: { kind_structure: 'S', rotate: '0' },
  },
  Brace: {
    tagName: 'StbBrace',
    container: ['StbMembers', 'StbBraces'],
    required: ['id_node_start', 'id_node_end', 'id_section'],
    hasName: true,
    defaults: { kind_structure: 'S', rotate: '0' },
  },
  // 面材: 2節点の線材と異なり、3点以上の節点列を StbNodeIdOrder 子要素で定義する。
  // nodeList:true の場合、addNewMember が node_ids（string[]）から StbNodeIdOrder を生成する。
  Slab: {
    tagName: 'StbSlab',
    container: ['StbMembers', 'StbSlabs'],
    required: ['id_section', 'kind_structure', 'kind_slab', 'isFoundation'],
    nodeList: true,
    hasName: true,
    defaults: { kind_structure: 'RC', kind_slab: 'NORMAL', isFoundation: 'false' },
  },
  Wall: {
    tagName: 'StbWall',
    container: ['StbMembers', 'StbWalls'],
    required: ['id_section', 'kind_structure', 'kind_layout'],
    nodeList: true,
    hasName: true,
    defaults: { kind_structure: 'RC', kind_layout: 'ON_GIRDER' },
  },
  // 基礎・パラペット: 子要素を持たず属性のみで定義する（StbNodeIdOrder は不要）。
  // 杭・基礎・基礎柱は1節点（id_node）で配置する点部材、パラペットは2節点線材。
  Pile: {
    tagName: 'StbPile',
    container: ['StbMembers', 'StbPiles'],
    required: ['id_node', 'id_section', 'kind_structure'],
    hasName: true,
    defaults: { kind_structure: 'RC', level_top: '0' },
  },
  Footing: {
    tagName: 'StbFooting',
    container: ['StbMembers', 'StbFootings'],
    required: ['id_node', 'id_section'],
    hasName: true,
    defaults: { level_bottom: '0', rotate: '0' },
  },
  // 基礎柱は id_section（単一）を持たず id_section_FD（基礎部・描画上の実質必須）と
  // id_section_WR（立上り部・任意）の2断面で定義する。
  FoundationColumn: {
    tagName: 'StbFoundationColumn',
    container: ['StbMembers', 'StbFoundationColumns'],
    required: ['id_node', 'kind_structure', 'id_section_FD'],
    hasName: true,
    defaults: { kind_structure: 'RC', rotate: '0' },
  },
  Parapet: {
    tagName: 'StbParapet',
    container: ['StbMembers', 'StbParapets'],
    required: ['id_node_start', 'id_node_end', 'id_section', 'kind_structure', 'kind_layout'],
    hasName: true,
    defaults: { kind_structure: 'RC', kind_layout: 'ON_GIRDER', offset: '0' },
  },
  // 階・通り芯: 部材ではなくモデルの基準情報。節点を StbNodeIdList 子要素で「紐づける」点が特徴。
  // nodeIdList:true の場合、addNewMember が node_ids（任意・0個可）から StbNodeIdList > StbNodeId を生成する。
  Story: {
    tagName: 'StbStory',
    container: ['StbStories'],
    required: ['name', 'height'],
    hasName: true,
    nodeIdList: true,
    defaults: { kind: 'GENERAL' },
  },
  // 通り芯は StbAxes > StbParallelAxes/StbArcAxes/StbRadialAxes[group_name] > StbXxxAxis の入れ子構造。
  // コンテナは group（グループ名）により動的に決まるため container は使わず axisGroup フラグで分岐する。
  // axisContainerTag: 軸グループ要素のタグ。groupAttrFields: 入力フィールド→グループ要素属性の対応
  // （グループ新設時のみ使用。group_name は別途設定）。これらと group/node_ids は軸要素の属性ループから除外する。
  Axis: {
    tagName: 'StbParallelAxis',
    axisGroup: true,
    axisContainerTag: 'StbParallelAxes',
    groupAttrFields: [],
    required: ['group', 'name', 'distance'],
    hasName: true,
    nodeIdList: true,
    defaults: { group: 'X', distance: '0' },
  },
  // 円弧軸: StbArcAxes（中心 X/Y・開始/終了角）配下に StbArcAxis（name・radius）。
  ArcAxis: {
    tagName: 'StbArcAxis',
    axisGroup: true,
    axisContainerTag: 'StbArcAxes',
    groupAttrFields: [
      { field: 'center_x', attr: 'X', default: '0.0' },
      { field: 'center_y', attr: 'Y', default: '0.0' },
      // stb:angle は [0,360)。360 は maxExclusive のため不正値。既定は 0〜90 の円弧。
      { field: 'start_angle', attr: 'start_angle', default: '0' },
      { field: 'end_angle', attr: 'end_angle', default: '90' },
    ],
    required: ['group', 'name', 'radius'],
    hasName: true,
    nodeIdList: true,
    // group は X/Y（または *_X/*_Y）のときのみレンダラ（drawAxes）が描画・選択対象にするため既定は 'X'。
    // radius は stb:length（>0）。既定は 1000mm。
    defaults: { group: 'X', radius: '1000' },
  },
  // 放射軸: StbRadialAxes（中心 X/Y）配下に StbRadialAxis（name・angle）。
  RadialAxis: {
    tagName: 'StbRadialAxis',
    axisGroup: true,
    axisContainerTag: 'StbRadialAxes',
    groupAttrFields: [
      { field: 'center_x', attr: 'X', default: '0.0' },
      { field: 'center_y', attr: 'Y', default: '0.0' },
    ],
    required: ['group', 'name', 'angle'],
    hasName: true,
    nodeIdList: true,
    // group は X/Y のときのみ描画・選択対象。angle は stb:angle（[0,360)）で 0 は有効。
    defaults: { group: 'X', angle: '0' },
  },
};

/**
 * 配置可能な新規部材タイプの定義を取得する（UI 用）。
 * @returns {Object<string, {tagName: string, container: string[], required: string[], defaults: Object<string,string>}>}
 */
export function getNewMemberDefinitions() {
  return NEW_MEMBER_DEFINITIONS;
}

/**
 * 新規部材を documentA に追加し、ATTRIBUTE_CHANGED で再比較・再描画パイプラインを起動する。
 * 履歴には {op:'add'} を記録し、Undo で削除できるようにする。
 * 面材（definition.nodeList=true）の場合、attrs.node_ids（string[]）から StbNodeIdOrder 子要素を生成する。
 * 階・通り芯（definition.nodeIdList=true）の場合、attrs.node_ids（任意）から StbNodeIdList 子要素を生成し、節点を紐づける。
 * 軸（definition.axisGroup=true）は attrs.group（グループ名）に応じた軸グループ（StbParallelAxes/StbArcAxes/StbRadialAxes）配下へ追加する。
 * @param {string} elementType - NEW_MEMBER_DEFINITIONS のキー（'Node' | 'Column' | 'Post' | 'Girder' | 'Beam' | 'Brace' | 'Slab' | 'Wall' | 'Pile' | 'Footing' | 'FoundationColumn' | 'Parapet' | 'Story' | 'Axis' | 'ArcAxis' | 'RadialAxis'）
 * @param {Object<string,string|string[]>} attrs - 属性値（id は自動採番、必須属性は definition.required）。面材・階・通り芯は node_ids に節点列を持つ。
 * @returns {{success: boolean, id: string|null, error?: string}}
 */
export function addNewMember(elementType, attrs = {}) {
  const def = NEW_MEMBER_DEFINITIONS[elementType];
  if (!def) {
    return { success: false, id: null, error: `未対応の部材タイプ: ${elementType}` };
  }

  const doc = getState('models.documentA');
  if (!doc) {
    return { success: false, id: null, error: 'モデルAが読み込まれていません' };
  }

  // 必須属性チェック
  const missing = def.required.filter((key) => {
    const v = attrs[key];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length > 0) {
    return { success: false, id: null, error: `必須項目が未入力です: ${missing.join(', ')}` };
  }

  // 面材は節点列（3点以上）を要求する。階・通り芯（nodeIdList）は任意（0個可）。
  const nodeIds = def.nodeList ? normalizeNodeIds(attrs.node_ids) : null;
  if (def.nodeList && nodeIds.length < 3) {
    return { success: false, id: null, error: '面材には3点以上の節点が必要です' };
  }
  // 階・通り芯に紐づける任意の節点列（StbNodeIdList 子要素として書き出す）
  const linkedNodeIds = def.nodeIdList ? normalizeNodeIds(attrs.node_ids) : null;

  // 軸（平行/円弧/放射）はグループ配下に追加するためコンテナを動的に解決する。
  const container = def.axisGroup
    ? ensureAxisGroup(doc, def, attrs)
    : ensureContainer(doc, def.container);
  if (!container) {
    return { success: false, id: null, error: 'StbModel が見つかりません' };
  }

  const ns = container.namespaceURI;
  const element = ns ? doc.createElementNS(ns, def.tagName) : doc.createElement(def.tagName);

  // 階・通り芯は部材と同じ id 空間で一意にする（モデル全体で採番）
  const id = generateNextId(doc, def.tagName, { global: def.nodeIdList === true });
  element.setAttribute('id', id);

  // デフォルト＋入力値を設定（入力値が優先）。node_ids は属性ではないため除外する。
  const merged = { ...def.defaults, ...attrs };

  // モデルAのバージョンに合わせる: name 属性は STB 2.0.x では XSD 必須・2.1.x では任意。
  // 直接作成フォームは name を入力させないため、2.1.x 以外（2.0.x / 判定不能）かつ
  // name 属性を持つ部材では自動採番し、追加した要素が読み込み元バージョンで妥当になるようにする。
  const version = detectStbVersion(doc);
  const is21x = version === '2.1.0' || version === '2.1.1';
  if (def.hasName && !is21x && !String(merged.name ?? '').trim()) {
    merged.name = `${def.tagName.replace(/^Stb/, '')}${id}`;
  }
  // node_ids は子要素、group はグループ名、グループ属性フィールド（中心・角度）は親グループ要素の
  // 属性として扱うため、いずれも軸要素自身の属性にはしない。
  const groupFieldKeys = new Set((def.groupAttrFields || []).map((f) => f.field));
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'node_ids' || key === 'group' || groupFieldKeys.has(key)) continue;
    if (value === undefined || value === null || String(value).trim() === '') continue;
    element.setAttribute(key, String(value));
  }

  // 面材: 節点列を StbNodeIdOrder 子要素（スペース区切りテキスト）として追加する
  if (def.nodeList) {
    const orderEl = ns
      ? doc.createElementNS(ns, 'StbNodeIdOrder')
      : doc.createElement('StbNodeIdOrder');
    orderEl.textContent = nodeIds.join(' ');
    element.appendChild(orderEl);
  }

  // 階・通り芯: 紐づける節点を StbNodeIdList > StbNodeId 子要素として追加する（0個なら省略）
  if (def.nodeIdList && linkedNodeIds.length > 0) {
    const listEl = ns
      ? doc.createElementNS(ns, 'StbNodeIdList')
      : doc.createElement('StbNodeIdList');
    for (const nodeId of linkedNodeIds) {
      const idEl = ns ? doc.createElementNS(ns, 'StbNodeId') : doc.createElement('StbNodeId');
      idEl.setAttribute('id', nodeId);
      listEl.appendChild(idEl);
    }
    element.appendChild(listEl);
  }

  container.appendChild(element);

  // 履歴に追加（Undo 対象）
  getModifications().push({ op: 'add', elementType, id, tagName: def.tagName });

  // 既存パイプラインを起動（部材タイプの全要素を再抽出 → 再比較 → 型単位再描画）
  emitStructuralChange(elementType, id);

  updateEditingSummary();
  showSuccess(`${def.tagName} #${id} を追加しました`);
  return { success: true, id };
}
