/**
 * @fileoverview STB XMLパーサー コアモジュール
 *
 * パーサー共通の基盤機能を提供します:
 * - ロガー設定
 * - StbExtensionsパーサー
 * - 汎用要素パース関数
 * - ノードマップ構築
 * - 階情報・通り芯情報パース
 * - ノード所属情報ルックアップ構築
 *
 * @module common/stb/parser/stbParserCore
 */

// --- 定数 ---
const STB_NAMESPACE = 'https://www.building-smart.or.jp/dl';

import { createKernelLogger } from '../config/kernelConfig.js';
import { parseStbExtensions } from './stbExtensions.js';

export { parseStbExtensions };

const _log = createKernelLogger('common-stb:parser:stbXmlParser');

// --- ロガー設定 ---
// デフォルトはcreateLogger、外部から差し替え可能
let logger = {
  log: (...args) => _log.info(...args),
  warn: (...args) => _log.warn(...args),
  debug: (...args) => _log.debug(...args),
  error: (...args) => _log.error(...args),
};

/**
 * ロガーを設定する
 * @param {Object} customLogger - カスタムロガーオブジェクト
 */
export function setLogger(customLogger) {
  if (customLogger) {
    logger = { ...logger, ...customLogger };
  }
}

/**
 * 内部ロガーを取得する（サブモジュール向け）
 * @returns {Object} ロガーオブジェクト
 */
export function getLogger() {
  return logger;
}

// --- 要素パース関数 (汎用) ---
/**
 * 指定された要素タイプの要素をXMLドキュメントから取得する。
 *
 * **用途**:
 * - 3D立体表示: メッシュジオメトリ生成の基礎データ
 * - 線分表示: 構造線生成の基礎データ
 * - 比較処理: モデルA・B間の要素差分解析
 *
 * @param {Document} doc - パースされたXMLドキュメント。
 * @param {string} elementType - 取得する要素のタグ名 (例: "StbColumn")。
 * @returns {Array<Element>} 取得した要素の配列。
 */
export function parseElements(doc, elementType) {
  if (!doc) return [];

  // getElementsByTagNameNS がサポートされている場合は使用
  if (typeof doc.getElementsByTagNameNS === 'function') {
    try {
      const elements = doc.getElementsByTagNameNS(STB_NAMESPACE, elementType);
      if (elements) {
        return Array.from(elements);
      }
    } catch (e) {
      // フォールバックへ
    }
  }

  // フォールバック: getElementsByTagName を使用（名前空間なし）
  if (typeof doc.getElementsByTagName === 'function') {
    const elements = doc.getElementsByTagName(elementType);
    if (elements) {
      return Array.from(elements);
    }
  }

  return [];
}

// --- ノードマップ構築関数 ---
/**
 * XMLドキュメントからノード情報を読み取り、ノードIDと座標のマッピングを作成する。
 *
 * **用途**:
 * - 3D立体表示: 柱・梁・ブレースのメッシュ配置座標として使用
 * - 線分表示: 構造線の端点座標として使用
 * - 要素間接続: 構造要素の結合部解析に使用
 *
 * @param {Document} doc - パースされたXMLドキュメント。
 * @returns {Map<string, {x: number, y: number, z: number}>} ノードIDをキー、座標オブジェクト(mm単位)を値とするMap。
 */
export function buildNodeMap(doc) {
  const nodeMap = new Map();
  if (!doc) return nodeMap;
  const nodes = parseElements(doc, 'StbNode');
  for (const node of nodes) {
    const id = node.getAttribute('id');

    // 属性値を取得
    const xAttr = node.getAttribute('X');
    const yAttr = node.getAttribute('Y');
    const zAttr = node.getAttribute('Z');

    // 座標値をパース
    const x = parseFloat(xAttr);
    const y = parseFloat(yAttr);
    const z = parseFloat(zAttr);

    // IDチェック
    if (!id) {
      logger.warn(`[Data] ノード: IDが欠落しています`);
      continue;
    }

    // 座標の有効性チェック（NaNとInfinityを除外）
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      logger.warn(`[Data] ノード ${id}: 無効な座標値 (X=${xAttr}, Y=${yAttr}, Z=${zAttr})`);
      continue;
    }

    // 極端に大きな座標値のチェック（潜在的なデータ破損）
    const MAX_COORD_VALUE = 1e9; // 1,000km in mm
    if (
      Math.abs(x) > MAX_COORD_VALUE ||
      Math.abs(y) > MAX_COORD_VALUE ||
      Math.abs(z) > MAX_COORD_VALUE
    ) {
      logger.warn(`[Data] ノード ${id}: 座標値が極端に大きいです (X=${x}, Y=${y}, Z=${z})`);
      // 警告のみで続行（データ破損の可能性があるが処理は継続）
    }

    nodeMap.set(id, { x, y, z });
  }
  logger.log(`[Load] ノードマップ構築完了: ${nodeMap.size}個`);

  return nodeMap;
}

// --- 階情報パース関数 ---
/**
 * XMLドキュメントから階情報をパースする。
 *
 * **用途**:
 * - 3D立体表示: 階レベル平面の立体表示・クリッピング平面設定
 * - 線分表示: 階高線・レベル線の2D表示
 * - UI制御: 階セレクターでの階別表示切り替え
 *
 * この関数で取得した階情報（名前、高さ）は、ビュー上に階名やレベル線を表示するために使用できます。
 * @param {Document} doc - パースされたXMLドキュメント。
 * @param {Object} [options] - オプション設定
 * @param {boolean} [options.includeNodeIds=false] - node_idsを含めるかどうか（デフォルト: false）
 * @returns {Array<{id: string, name: string, height: number, kind?: string, node_ids?: string[]}>} 階情報の配列（高さ(mm単位)でソート済み）。
 */
export function parseStories(doc, options = {}) {
  if (!doc) return [];
  const { includeNodeIds = false } = options;

  const stories = parseElements(doc, 'StbStory');
  const parsed = stories
    .map((s) => {
      const heightAttr = s.getAttribute('height');
      const height = heightAttr !== null ? parseFloat(heightAttr) : NaN;

      const storyData = {
        id: s.getAttribute('id'),
        name: s.getAttribute('name'),
        height: height,
        kind: s.getAttribute('kind') || 'GENERAL',
      };

      // オプション: StbNodeIdList 内の節点IDを取得
      if (includeNodeIds) {
        const nodeIds = [];
        const nodeList = parseElements(s, 'StbNodeIdList')[0];
        if (nodeList) {
          const idElements = parseElements(nodeList, 'StbNodeId');
          for (const idEl of idElements) {
            const nid = idEl.getAttribute('id');
            if (nid) nodeIds.push(nid);
          }
        }
        storyData.node_ids = nodeIds;
      }

      return storyData;
    })
    .filter((s) => !isNaN(s.height));

  logger.log(`[Load] 階情報読込完了: ${parsed.length}階`);

  return parsed.sort((a, b) => a.height - b.height);
}

// --- 通り芯情報パース関数 ---
/**
 * ST-Bridge XMLドキュメントから通り芯データをパースする。
 *
 * **用途**:
 * - 3D立体表示: 通り芯の立体グリッド表示・参照平面設定
 * - 線分表示: 通り芯線の2D表示・建築図面風表示
 * - UI制御: 軸セレクターでの軸別表示切り替え
 *
 * @param {XMLDocument} doc - パース済みのXMLドキュメント。
 * @param {Object} [options] - オプション設定
 * @param {boolean} [options.includeNodeIds=false] - node_idsを含めるかどうか（デフォルト: false）
 * @returns {object} 軸データ ({ xAxes: [], yAxes: [] }) (距離はmm単位)。
 */
export function parseAxes(doc, options = {}) {
  const { includeNodeIds = false } = options;
  const xAxes = [];
  const yAxes = [];
  const arcAxes = [];
  const radialAxes = [];

  const collectNodeIds = (axis) => {
    const nodeIds = [];
    const nodeList = axis.getElementsByTagName('StbNodeIdList')[0];
    if (nodeList) {
      const idElements = Array.from(nodeList.getElementsByTagName('StbNodeId'));
      for (const idEl of idElements) {
        const nid = idEl.getAttribute('id');
        if (nid) nodeIds.push(nid);
      }
    }
    return nodeIds;
  };

  const pushAxisByGroup = (axisData, groupName) => {
    const isXGroup = groupName === 'X' || groupName?.endsWith('_X');
    const isYGroup = groupName === 'Y' || groupName?.endsWith('_Y');
    if (isXGroup) {
      xAxes.push(axisData);
    } else if (isYGroup) {
      yAxes.push(axisData);
    }
  };

  // <StbParallelAxes> 要素をすべて取得
  const parallelAxesElements = parseElements(doc, 'StbParallelAxes');

  for (let i = 0; i < parallelAxesElements.length; i++) {
    const parallelAxes = parallelAxesElements[i];
    const groupName = parallelAxes.getAttribute('group_name');
    // StbParallelAxes の原点座標と角度を取得
    const originX = parseFloat(parallelAxes.getAttribute('X')) || 0;
    const originY = parseFloat(parallelAxes.getAttribute('Y')) || 0;
    const angle = parseFloat(parallelAxes.getAttribute('angle')) || 0;

    // <StbParallelAxis> 要素を取得
    const axisElements = parallelAxes.getElementsByTagName
      ? Array.from(parallelAxes.getElementsByTagName('StbParallelAxis'))
      : [];

    for (let j = 0; j < axisElements.length; j++) {
      const axis = axisElements[j];
      const id = axis.getAttribute('id') || `${groupName}_${j}`;
      const name = axis.getAttribute('name');
      const distance = parseFloat(axis.getAttribute('distance'));

      // 実際の座標を計算
      // ST-Bridge仕様:
      // - angle=270 (X軸グループ標準): Y方向に平行な線、distanceはX方向のオフセット
      // - angle=0 (Y軸グループ標準): X方向に平行な線、distanceはY方向のオフセット
      // 座標 = 原点 + distance * (角度に垂直な方向の単位ベクトル)
      const angleRad = (angle * Math.PI) / 180;
      // 垂直方向（angle + 90度）のベクトル
      const perpAngleRad = angleRad + Math.PI / 2;
      const actualX = originX + distance * Math.cos(perpAngleRad);
      const actualY = originY + distance * Math.sin(perpAngleRad);

      const axisData = {
        id,
        name,
        axisKind: 'parallel',
        distance,
        // 実際の座標位置を追加
        x: actualX,
        y: actualY,
        angle, // 軸線の角度（度）
        originX,
        originY,
      };

      // オプション: StbNodeIdList 内の節点IDを取得
      if (includeNodeIds) {
        axisData.node_ids = collectNodeIds(axis);
      }

      if (name && !isNaN(distance)) {
        pushAxisByGroup(axisData, groupName);
      } else {
        logger.warn(
          `[Data] 軸: 無効なデータをスキップ (ID=${axis.getAttribute('id')}, Name=${name}, Distance=${axis.getAttribute('distance')})`,
        );
      }
    }
  }

  // <StbArcAxes> 要素をすべて取得
  const arcAxesElements = parseElements(doc, 'StbArcAxes');
  for (let i = 0; i < arcAxesElements.length; i++) {
    const arcAxesElement = arcAxesElements[i];
    const groupName = arcAxesElement.getAttribute('group_name');
    const originX = parseFloat(arcAxesElement.getAttribute('X')) || 0;
    const originY = parseFloat(arcAxesElement.getAttribute('Y')) || 0;
    const startAngle = parseFloat(arcAxesElement.getAttribute('start_angle'));
    const endAngle = parseFloat(arcAxesElement.getAttribute('end_angle'));
    const axisElements = arcAxesElement.getElementsByTagName
      ? Array.from(arcAxesElement.getElementsByTagName('StbArcAxis'))
      : [];

    for (let j = 0; j < axisElements.length; j++) {
      const axis = axisElements[j];
      const id = axis.getAttribute('id') || `${groupName}_arc_${j}`;
      const name = axis.getAttribute('name');
      const radius = parseFloat(axis.getAttribute('radius'));

      const axisData = {
        id,
        name,
        axisKind: 'arc',
        distance: radius,
        radius,
        originX,
        originY,
        startAngle,
        endAngle,
      };

      if (includeNodeIds) {
        axisData.node_ids = collectNodeIds(axis);
      }

      if (
        name &&
        Number.isFinite(radius) &&
        Number.isFinite(startAngle) &&
        Number.isFinite(endAngle)
      ) {
        arcAxes.push(axisData);
        pushAxisByGroup(axisData, groupName);
      } else {
        logger.warn(
          `[Data] 円弧軸: 無効なデータをスキップ (ID=${axis.getAttribute('id')}, Name=${name}, Radius=${axis.getAttribute('radius')})`,
        );
      }
    }
  }

  // <StbRadialAxes> 要素をすべて取得
  const radialAxesElements = parseElements(doc, 'StbRadialAxes');
  for (let i = 0; i < radialAxesElements.length; i++) {
    const radialAxesElement = radialAxesElements[i];
    const groupName = radialAxesElement.getAttribute('group_name');
    const originX = parseFloat(radialAxesElement.getAttribute('X')) || 0;
    const originY = parseFloat(radialAxesElement.getAttribute('Y')) || 0;
    const axisElements = radialAxesElement.getElementsByTagName
      ? Array.from(radialAxesElement.getElementsByTagName('StbRadialAxis'))
      : [];

    for (let j = 0; j < axisElements.length; j++) {
      const axis = axisElements[j];
      const id = axis.getAttribute('id') || `${groupName}_radial_${j}`;
      const name = axis.getAttribute('name');
      const angle = parseFloat(axis.getAttribute('angle'));

      const axisData = {
        id,
        name,
        axisKind: 'radial',
        distance: angle,
        angle,
        originX,
        originY,
      };

      if (includeNodeIds) {
        axisData.node_ids = collectNodeIds(axis);
      }

      if (name && Number.isFinite(angle)) {
        radialAxes.push(axisData);
        pushAxisByGroup(axisData, groupName);
      } else {
        logger.warn(
          `[Data] 放射軸: 無効なデータをスキップ (ID=${axis.getAttribute('id')}, Name=${name}, Angle=${axis.getAttribute('angle')})`,
        );
      }
    }
  }

  // 距離でソート
  xAxes.sort((a, b) => a.distance - b.distance);
  yAxes.sort((a, b) => a.distance - b.distance);

  logger.log(
    `[Load] 軸情報読込完了: X軸${xAxes.length}本, Y軸${yAxes.length}本, 円弧${arcAxes.length}本, 放射${radialAxes.length}本`,
  );

  return { xAxes, yAxes, arcAxes, radialAxes };
}

/**
 * 通り芯要素（StbParallelAxis / StbArcAxis / StbRadialAxis）から、幾何位置ベースの
 * 対応キー成分を算出する。親 *Axes の原点(X/Y)・角度と自身の距離/半径/角度から、
 * parseAxes と同じ式で実座標・実角度を求め、名称に依存しないキー文字列を返す。
 *
 * 別ソフト/別モデルで通り芯の符号（name）が異なっても、原点＋距離が整合していれば
 * 同一とみなすための比較キーに用いる（STORY_AXIS_MATCH_CRITERION.GEOMETRY）。
 *
 * 座標・半径は toleranceConfig の位置許容差（basePoint=10mm）と同オーダーの
 * 10mm グリッド、角度は方向角許容差（1度）と同オーダーの 1度 グリッドに量子化して
 * キー化する。別ソフトの座標丸め・浮動小数点誤差を吸収する目的のため、1mm/1度の
 * 素の丸めより粗い粒度を採用している。
 *
 * @param {Element} axisEl - 通り芯要素の DOM ノード
 * @returns {string|null} 幾何位置キー成分（算出不能時は null）
 */
export function computeAxisGeometryKey(axisEl) {
  if (!axisEl || typeof axisEl.getAttribute !== 'function') return null;
  const tag = axisEl.tagName || axisEl.nodeName || '';
  const parent = axisEl.parentElement || axisEl.parentNode;
  const getParentAttr = (attr) =>
    parent && typeof parent.getAttribute === 'function' ? parent.getAttribute(attr) : null;
  const originX = parseFloat(getParentAttr('X')) || 0;
  const originY = parseFloat(getParentAttr('Y')) || 0;
  // 座標は 10mm、角度は 1度 グリッドへ量子化（toleranceConfig と同オーダー）
  const COORD_QUANTUM_MM = 10;
  const ANGLE_QUANTUM_DEG = 1;
  const qCoord = (v) => Math.round(v / COORD_QUANTUM_MM);
  const qAngle = (v) => Math.round(v / ANGLE_QUANTUM_DEG);

  if (tag === 'StbParallelAxis') {
    const distance = parseFloat(axisEl.getAttribute('distance'));
    if (!Number.isFinite(distance)) return null;
    const angle = parseFloat(getParentAttr('angle')) || 0;
    // 距離は角度に垂直な方向のオフセット（parseAxes と同一式）
    const perpAngleRad = (angle * Math.PI) / 180 + Math.PI / 2;
    const x = originX + distance * Math.cos(perpAngleRad);
    const y = originY + distance * Math.sin(perpAngleRad);
    return `parallel:${qCoord(x)}:${qCoord(y)}`;
  }

  if (tag === 'StbArcAxis') {
    const radius = parseFloat(axisEl.getAttribute('radius'));
    if (!Number.isFinite(radius)) return null;
    // 円弧は原点・半径・角度範囲で同定する。角度範囲は欠落と 0度 を区別するため
    // Number.isFinite で検証し、無効なら算出不能（null）とする（parseAxes と同基準）。
    const startAngle = parseFloat(getParentAttr('start_angle'));
    const endAngle = parseFloat(getParentAttr('end_angle'));
    if (!Number.isFinite(startAngle) || !Number.isFinite(endAngle)) return null;
    return `arc:${qCoord(originX)}:${qCoord(originY)}:${qCoord(radius)}:${qAngle(startAngle)}:${qAngle(endAngle)}`;
  }

  if (tag === 'StbRadialAxis') {
    const angle = parseFloat(axisEl.getAttribute('angle'));
    if (!Number.isFinite(angle)) return null;
    return `radial:${qCoord(originX)}:${qCoord(originY)}:${qAngle(angle)}`;
  }

  return null;
}

// --- ノード所属情報ルックアップ構築関数 ---
/**
 * XMLドキュメントからノードIDをキーとする所属階・所属通芯の逆引きマップを構築する。
 *
 * StbStory と StbParallelAxis の StbNodeIdList を解析し、
 * 各ノードがどの階・どの通芯に所属しているかを高速に検索できるMapを返します。
 *
 * @param {Document} doc - パース済みのXMLドキュメント。
 * @returns {Map<string, {storyName: string|null, axisNames: string[]}>}
 *   ノードIDをキー、所属情報を値とするMap。
 */
export function buildNodeStoryAxisLookup(doc) {
  const lookup = new Map();
  if (!doc) return lookup;

  // 階情報から所属階を構築
  const stories = parseStories(doc, { includeNodeIds: true });
  for (const story of stories) {
    if (story.node_ids) {
      for (const nodeId of story.node_ids) {
        if (!lookup.has(nodeId)) {
          lookup.set(nodeId, { storyName: null, axisNames: [] });
        }
        lookup.get(nodeId).storyName = story.name;
      }
    }
  }

  // 通芯情報から所属通芯を構築
  const axes = parseAxes(doc, { includeNodeIds: true });
  const allAxes = [...axes.xAxes, ...axes.yAxes];
  for (const axis of allAxes) {
    if (axis.node_ids) {
      for (const nodeId of axis.node_ids) {
        if (!lookup.has(nodeId)) {
          lookup.set(nodeId, { storyName: null, axisNames: [] });
        }
        lookup.get(nodeId).axisNames.push(axis.name);
      }
    }
  }

  // SS7原典グリッド属性（StbExtensions経由）によるフォールバック補完
  // 節点同一化・軸振れ等でStbParallelAxisのNodeIdListに登録されなかったノードや
  // getFramePath で shared=[] になるノードを正しくマップするために使用
  const ss7ExtMap = parseStbExtensions(doc, 'StbNode');
  for (const [nodeId, props] of ss7ExtMap) {
    const ss7X = props.ss7_x;
    const ss7Y = props.ss7_y;
    const ss7Story = props.ss7_story;
    if (!ss7X || !ss7Y) continue;

    if (!lookup.has(nodeId)) {
      lookup.set(nodeId, { storyName: null, axisNames: [] });
    }
    const entry = lookup.get(nodeId);
    // ss7_story で storyName を上書き（より信頼性が高い）
    if (ss7Story) entry.storyName = ss7Story;
    // ss7_x/ss7_y で axisNames を上書き（NodeIdList依存より正確）
    entry.axisNames = [ss7X, ss7Y];
  }

  logger.log(`[Load] ノード所属情報ルックアップ構築完了: ${lookup.size}ノード`);
  return lookup;
}

export { STB_NAMESPACE };
