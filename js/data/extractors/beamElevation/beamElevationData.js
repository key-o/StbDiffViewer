/**
 * @fileoverview 梁立面図（貫通孔配置可能範囲）用データ抽出
 *
 * 選択された大梁/小梁（StbGirder/StbBeam）を含む「連続梁」について、立面図の
 * 描画に必要な次の情報を算定して返す。
 * ・連続する各スパンの柱芯間距離と柱面間の内法スパンL0
 * ・各支点の柱せい（梁軸方向への投影値）と通り芯名
 * ・RC梁断面の寸法・配筋（端部/中央、2段筋）
 * ・主筋カットオフ位置（L0/4 + 15d）と柱内定着（のみこみ）寸法
 * ・貫通孔の配置可能範囲（孔径 ≤ D/3 かつ 750mm、柱面から ≥ D、中心間隔 ≥ 3H）
 *
 * ST-Bridgeには貫通孔可否・カットオフ・定着位置の情報が含まれないため、
 * ここで算定する値は設計指針に基づく目安である（結果に注記を含める）。
 *
 * @module data/extractors/beamElevation/beamElevationData
 */

import { querySelector, querySelectorAll } from '../sectionListUtils.js';
import {
  createTagScanner,
  extractColumnPlanDimensions,
  findColumnAtNode,
  findElementById,
  getNodeCoord,
  projectColumnDepth,
} from '../columnSupportUtils.js';
import { extractRcBeamSectionDetail } from '../beamSectionList/sectionDetail.js';
import {
  BEAM_OPENING_RULES,
  REBAR_SPACING_RULES,
  barDiameterMm,
} from '../../../constants/beamOpeningRules.js';
import { REBAR_CUTOFF_RULES } from '../../../constants/rebarCutoffRules.js';
import { REBAR_ANCHORAGE_RULES } from '../../../constants/rebarAnchorageRules.js';

/** 貫通孔対象外とする梁せいの下限 [mm] */
const MIN_DEPTH_MM = 1;

/** 連続梁として辿るスパン数の上限（異常データでの暴走防止） */
const MAX_SPANS = 12;

/** 同一直線とみなす方向差の許容値（単位ベクトルの外積） */
const PARALLEL_TOLERANCE = 1e-3;

/** 節点が通り芯上にあるとみなす座標許容差 [mm] */
const AXIS_MATCH_TOLERANCE_MM = 50;

/**
 * 数値配列の中央値を返す
 * @param {Array<number>} values - 数値配列（空でないこと）
 * @returns {number}
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * 基礎梁かどうかを判定する。
 * `isFoundation` 属性を優先し、属性が無い旧データでは梁名・断面名の先頭 `F` で補完する。
 * @param {Element} beamEl - 梁要素
 * @param {string|null} [sectionName] - 断面名
 * @returns {boolean}
 */
function resolveIsFoundationBeam(beamEl, sectionName = null) {
  const attr = beamEl.getAttribute('isFoundation');
  if (attr === 'true') return true;
  if (attr === 'false') return false;
  return /^F/i.test(`${beamEl.getAttribute('name') || ''}${sectionName || ''}`);
}

/**
 * 通り芯（StbParallelAxes / StbParallelAxis）の一覧を作る。
 *
 * 通り芯の位置は StbParallelAxes の原点(X,Y)・angle と StbParallelAxis の distance から
 * 算出する（common-stb/import の parseAxes と同じ式）。StbNodeIdList はSTBスキーマ上
 * 任意項目のため、これに依存せず解決できるようにする。
 * 節点一覧がある場合は、その座標の中央値を優先して採用する（出力ソフトによる
 * distance の基準ずれを吸収するため）。
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {function(string): {x:number,y:number}|null} coordOf - 節点座標取得関数
 * @returns {Array<{group:string, varyingKey:'x'|'y', axes:Array<{name:string, position:number}>}>}
 */
function resolveAxisGroups(scanTag, coordOf) {
  const groups = [];

  for (const axesEl of scanTag('StbParallelAxes')) {
    const group = axesEl.getAttribute('group_name') || '';
    const originX = parseFloat(axesEl.getAttribute('X')) || 0;
    const originY = parseFloat(axesEl.getAttribute('Y')) || 0;
    const angle = parseFloat(axesEl.getAttribute('angle')) || 0;

    // 通り芯線は angle 方向に伸びるため、通り芯どうしを区別する値は
    // その直交方向（angle+90°）の成分になる。
    const perpAngleRad = ((angle + 90) * Math.PI) / 180;
    const perpX = Math.cos(perpAngleRad);
    const perpY = Math.sin(perpAngleRad);
    const varyingKey = Math.abs(perpX) >= Math.abs(perpY) ? 'x' : 'y';

    const axes = [];
    for (const axisEl of querySelectorAll(axesEl, 'StbParallelAxis')) {
      const name = axisEl.getAttribute('name');
      const distance = parseFloat(axisEl.getAttribute('distance'));
      if (!name) continue;

      // 節点一覧があれば座標を正とし、無ければ distance から算出する
      const coords = querySelectorAll(axisEl, 'StbNodeId')
        .map((el) => coordOf(el.getAttribute('id')))
        .filter(Boolean);
      let position = null;
      if (coords.length > 0) {
        position = median(coords.map((c) => (varyingKey === 'x' ? c.x : c.y)));
      } else if (Number.isFinite(distance)) {
        position = varyingKey === 'x' ? originX + distance * perpX : originY + distance * perpY;
      }
      if (position === null) continue;

      axes.push({ name, position });
    }
    if (axes.length > 0) groups.push({ group, varyingKey, axes });
  }
  return groups;
}

/**
 * 節点座標に最も近い通り芯名を返す
 * @param {Object} groupInfo - resolveAxisGroups の1要素
 * @param {{x:number, y:number}|null} coord - 節点座標
 * @returns {string|null}
 */
function findAxisNameAt(groupInfo, coord) {
  if (!groupInfo || !coord) return null;
  const value = groupInfo.varyingKey === 'x' ? coord.x : coord.y;
  let best = null;
  for (const axis of groupInfo.axes) {
    const diff = Math.abs(axis.position - value);
    if (diff <= AXIS_MATCH_TOLERANCE_MM && (best === null || diff < best.diff)) {
      best = { name: axis.name, diff };
    }
  }
  return best?.name || null;
}

/**
 * 梁要素の平面方向（単位ベクトル）と長さを求める
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {Element} beamEl - 梁要素
 * @returns {{dir:{x:number,y:number}, length:number, start:Object, end:Object}|null}
 */
function getBeamGeometry(scanTag, beamEl) {
  const start = getNodeCoord(scanTag, beamEl.getAttribute('id_node_start'));
  const end = getNodeCoord(scanTag, beamEl.getAttribute('id_node_end'));
  if (!start || !end) return null;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const planLength = Math.hypot(dx, dy);
  const length = Math.hypot(dx, dy, end.z - start.z);
  if (length <= 0) return null;

  const dir = planLength > 0 ? { x: dx / planLength, y: dy / planLength } : { x: 1, y: 0 };
  return { dir, length, start, end };
}

/**
 * 2つの方向ベクトルが同一直線上（平行）かを判定
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {boolean}
 */
function isParallel(a, b) {
  return Math.abs(a.x * b.y - a.y * b.x) < PARALLEL_TOLERANCE;
}

/**
 * 選択された梁から、同一直線上に連続する梁を端まで辿る。
 *
 * 節点を共有し、かつ平面方向が平行な同種要素（StbGirder同士など）を連結とみなす。
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {Element} seedEl - 起点の梁要素
 * @param {string} tagName - 対象タグ名（StbGirder / StbBeam）
 * @param {{x:number,y:number}} seedDir - 起点の方向
 * @returns {Array<Element>} 始端から終端の順に並んだ梁要素
 */
function collectContinuousRun(scanTag, seedEl, tagName, seedDir) {
  const all = scanTag(tagName);
  const byStartNode = new Map();
  const byEndNode = new Map();
  for (const el of all) {
    const startId = el.getAttribute('id_node_start');
    const endId = el.getAttribute('id_node_end');
    if (startId) {
      if (!byStartNode.has(startId)) byStartNode.set(startId, []);
      byStartNode.get(startId).push(el);
    }
    if (endId) {
      if (!byEndNode.has(endId)) byEndNode.set(endId, []);
      byEndNode.get(endId).push(el);
    }
  }

  const visited = new Set([seedEl.getAttribute('id')]);

  /**
   * 指定節点から先へ連続する梁を1本探す
   * @param {string} nodeId - 接続節点ID
   * @returns {{element:Element, nextNodeId:string}|null}
   */
  const findNext = (nodeId) => {
    const candidates = [...(byStartNode.get(nodeId) || []), ...(byEndNode.get(nodeId) || [])];
    for (const el of candidates) {
      if (visited.has(el.getAttribute('id'))) continue;
      const geometry = getBeamGeometry(scanTag, el);
      if (!geometry || !isParallel(seedDir, geometry.dir)) continue;
      const startId = el.getAttribute('id_node_start');
      const endId = el.getAttribute('id_node_end');
      return { element: el, nextNodeId: startId === nodeId ? endId : startId };
    }
    return null;
  };

  // 前後を交互に辿る。片側だけを先に上限まで辿ると、
  // 反対側に連続梁があっても打ち切られてしまうため。
  const forward = [];
  const backward = [];
  let forwardNodeId = seedEl.getAttribute('id_node_end');
  let backwardNodeId = seedEl.getAttribute('id_node_start');

  while (forward.length + backward.length + 1 < MAX_SPANS) {
    let extended = false;

    if (forwardNodeId) {
      const next = findNext(forwardNodeId);
      if (next) {
        visited.add(next.element.getAttribute('id'));
        forward.push(next.element);
        forwardNodeId = next.nextNodeId;
        extended = true;
      } else {
        forwardNodeId = null;
      }
    }

    if (backwardNodeId && forward.length + backward.length + 1 < MAX_SPANS) {
      const next = findNext(backwardNodeId);
      if (next) {
        visited.add(next.element.getAttribute('id'));
        backward.unshift(next.element);
        backwardNodeId = next.nextNodeId;
        extended = true;
      } else {
        backwardNodeId = null;
      }
    }

    if (!extended) break;
  }

  return [...backward, seedEl, ...forward];
}

/**
 * 断面詳細の位置データから代表位置を取り出す
 * @param {Object} positions - extractRcBeamSectionDetail の positions
 * @param {Array<string>} preferred - 優先順の位置名
 * @returns {Object|null}
 */
function pickPosition(positions, preferred) {
  for (const key of preferred) {
    if (positions[key]) return positions[key];
  }
  return Object.values(positions)[0] || null;
}

/**
 * 主筋情報を表示用文字列へ整形（例: "3-D25 + 2段 2-D25"）
 * @param {Object|null} bar - {count, count1st, count2nd, dia}
 * @returns {string}
 */
function formatMainBar(bar) {
  if (!bar || !bar.count) return '-';
  const first = `${bar.count1st || bar.count}-${bar.dia || '?'}`;
  if (bar.count2nd > 0) {
    return `${first} + 2段 ${bar.count2nd}-${bar.dia || '?'}`;
  }
  return first;
}

/**
 * あばら筋情報を表示用文字列へ整形（例: "2-D13@200"）
 * @param {Object|null} stirrup - {count, dia, pitch}
 * @returns {string}
 */
function formatStirrup(stirrup) {
  if (!stirrup || !stirrup.dia) return '-';
  const count = stirrup.count ? `${stirrup.count}-` : '';
  const pitch = stirrup.pitch ? `@${stirrup.pitch}` : '';
  return `${count}${stirrup.dia}${pitch}`;
}

/**
 * 位置データを表示用サマリーへ変換
 * @param {Object|null} pos - positions の1要素
 * @returns {Object|null}
 */
function summarizePosition(pos) {
  if (!pos) return null;
  const layerCounts = (bar) => ({
    total: bar?.count || 0,
    first: bar?.count1st || bar?.count || 0,
    second: bar?.count2nd || 0,
    dia: bar?.dia || null,
  });
  return {
    width: pos.width || 0,
    depth: pos.depth || 0,
    topBarText: formatMainBar(pos.topBar),
    bottomBarText: formatMainBar(pos.bottomBar),
    stirrupText: formatStirrup(pos.stirrup),
    topBar: layerCounts(pos.topBar),
    bottomBar: layerCounts(pos.bottomBar),
    stirrup: pos.stirrup ? { dia: pos.stirrup.dia, pitch: pos.stirrup.pitch || 0 } : null,
    cover: pos.cover || null,
  };
}

/**
 * RC梁断面を解決する
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {string} sectionId - 断面ID
 * @returns {Object|null} extractRcBeamSectionDetail の結果
 */
function resolveRcBeamSection(scanTag, sectionId) {
  const sectionEl =
    findElementById(scanTag, 'StbSecBeam_RC', sectionId) ||
    findElementById(scanTag, 'StbSecGirder_RC', sectionId);
  return sectionEl ? extractRcBeamSectionDetail(sectionEl) : null;
}

/**
 * 支点（柱）情報を組み立てる
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {string} nodeId - 節点ID
 * @param {{x:number,y:number}} beamDir - 梁軸方向
 * @param {number} positionMm - 連続梁始端からの距離
 * @param {string|null} axisName - 支点位置の通り芯名
 * @param {number} levelZ - 節点のZ座標（高さ）
 * @returns {Object} 支点データ
 */
function buildSupport(scanTag, nodeId, beamDir, positionMm, axisName, levelZ) {
  const columnEl = findColumnAtNode(scanTag, nodeId);
  const dims = columnEl
    ? extractColumnPlanDimensions(scanTag, columnEl.getAttribute('id_section'))
    : null;
  const depthAlongBeam = projectColumnDepth(dims, beamDir);

  return {
    nodeId,
    positionMm,
    axisName,
    /** 節点の高さ [mm]（梁天端レベルの基準） */
    levelZ,
    hasColumn: Boolean(columnEl),
    column: columnEl
      ? {
          id: columnEl.getAttribute('id'),
          name: columnEl.getAttribute('name') || dims?.name || null,
          sectionName: dims?.name || null,
          shape: dims?.shape || null,
          widthX: dims?.widthX || 0,
          widthY: dims?.widthY || 0,
        }
      : null,
    depthAlongBeam,
  };
}

/**
 * 梁の方向から、支点ラベル用と梁が乗る通り用の通り芯グループを選ぶ。
 *
 * 梁がX方向に走るなら支点はX座標で区別されるため、X座標方向に並ぶ
 * 通り芯グループを支点ラベルに、もう一方を「梁が乗る通り」に使う。
 * @param {Array<Object>} axisGroups - resolveAxisGroups の結果
 * @param {{x:number, y:number}} beamDir - 梁軸方向
 * @returns {{supportGroup:Object|null, lineGroup:Object|null}}
 */
function selectAxisGroups(axisGroups, beamDir) {
  const beamAlongX = Math.abs(beamDir.x) >= Math.abs(beamDir.y);
  const supportKey = beamAlongX ? 'x' : 'y';
  return {
    supportGroup: axisGroups.find((g) => g.varyingKey === supportKey) || null,
    lineGroup: axisGroups.find((g) => g.varyingKey !== supportKey) || null,
  };
}

/**
 * 梁に接するスラブの厚さ [mm] を求める。
 *
 * スラブ天端＝梁天端として扱うため、スラブがある範囲は梁上部が
 * スラブ厚さ分だけ貫通孔を通せない領域になる。
 * 梁の両端節点をともに含む StbSlab を隣接スラブとみなし、最大厚さを採用する。
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {string} startNodeId - 梁始端の節点ID
 * @param {string} endNodeId - 梁終端の節点ID
 * @returns {{depth:number, name:string|null}} スラブ厚さと符号（無ければ depth=0）
 */
function findAdjacentSlab(scanTag, startNodeId, endNodeId) {
  let best = { depth: 0, name: null };

  for (const slabEl of scanTag('StbSlab')) {
    const orderEl = querySelector(slabEl, 'StbNodeIdOrder');
    // StbNodeIdOrder は空白区切りのテキスト。古い形式の StbNodeId 子要素にも備える。
    const ids = orderEl
      ? String(orderEl.textContent || '')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
      : querySelectorAll(slabEl, 'StbNodeId')
          .map((el) => el.getAttribute('id'))
          .filter(Boolean);
    if (!ids.includes(startNodeId) || !ids.includes(endNodeId)) continue;

    const sectionEl = findElementById(scanTag, 'StbSecSlab_RC', slabEl.getAttribute('id_section'));
    const straight = sectionEl ? querySelector(sectionEl, 'StbSecSlab_RC_Straight') : null;
    const depth = parseFloat(straight?.getAttribute('depth')) || 0;
    if (depth > best.depth) {
      best = {
        depth,
        name: sectionEl?.getAttribute('name') || slabEl.getAttribute('name') || null,
      };
    }
  }
  return best;
}

/**
 * スパンごとの算定（内法スパン・カットオフ・定着・貫通孔範囲）を行う
 * @param {Object} params - 算定パラメータ
 * @returns {Object} スパンデータ
 */
function buildSpan({ beamEl, sectionDetail, startSupport, endSupport, index, supportIndex, slab }) {
  const positions = sectionDetail.positions || {};
  const startPos = pickPosition(positions, ['LEFT', 'SAME', 'CENTER']);
  const centerPos = pickPosition(positions, ['CENTER', 'SAME', 'LEFT']);
  const endPos = pickPosition(positions, ['RIGHT', 'LEFT', 'SAME', 'CENTER']);

  const depth = Math.max(startPos?.depth || 0, centerPos?.depth || 0, endPos?.depth || 0);
  const width = Math.max(startPos?.width || 0, centerPos?.width || 0, endPos?.width || 0);

  const startMm = startSupport.positionMm;
  const endMm = endSupport.positionMm;

  // 梁天端レベル（節点Z + Zオフセット）。ST-Bridgeでは節点が梁天端中心を表す。
  // 始端・終端で異なる場合は段差梁・傾斜梁となる。
  const startIsBeamStart = beamEl.getAttribute('id_node_start') === startSupport.nodeId;
  const offsetStartZ = parseFloat(beamEl.getAttribute('offset_start_Z')) || 0;
  const offsetEndZ = parseFloat(beamEl.getAttribute('offset_end_Z')) || 0;
  const topLevelStart = startSupport.levelZ + (startIsBeamStart ? offsetStartZ : offsetEndZ);
  const topLevelEnd = endSupport.levelZ + (startIsBeamStart ? offsetEndZ : offsetStartZ);
  const faceStartMm = startMm + startSupport.depthAlongBeam / 2;
  const faceEndMm = endMm - endSupport.depthAlongBeam / 2;
  const clearSpan = faceEndMm - faceStartMm;

  const topBarDia = barDiameterMm(startPos?.topBar?.dia || centerPos?.topBar?.dia, 25);
  const bottomBarDia = barDiameterMm(startPos?.bottomBar?.dia || centerPos?.bottomBar?.dia, 25);
  const quarterSpan = clearSpan * REBAR_CUTOFF_RULES.cutoffSpanRatio;
  const extensionFactor = REBAR_CUTOFF_RULES.cutoffExtensionDiaFactor;

  const cutoff = {
    quarterSpan,
    topBarDia,
    bottomBarDia,
    topCutoffFromFace: quarterSpan + extensionFactor * topBarDia,
    bottomCutoffFromFace: quarterSpan + extensionFactor * bottomBarDia,
    topSecondLayerStart: (startPos?.topBar?.count2nd || 0) > 0,
    topSecondLayerEnd: (endPos?.topBar?.count2nd || 0) > 0,
    bottomSecondLayerStart: (startPos?.bottomBar?.count2nd || 0) > 0,
    bottomSecondLayerEnd: (endPos?.bottomBar?.count2nd || 0) > 0,
  };

  // 柱内定着（のみこみ）。水平投影定着長さ La は柱せいの3/4以上。
  const anchorage = {
    start: buildAnchorage(startSupport, topBarDia, bottomBarDia),
    end: buildAnchorage(endSupport, topBarDia, bottomBarDia),
  };

  // 貫通孔配置可能範囲
  const maxDiameter = Math.min(
    depth * BEAM_OPENING_RULES.maxDiameterDepthRatio,
    BEAM_OPENING_RULES.maxDiameterMm,
  );
  const endClearance = depth * BEAM_OPENING_RULES.endClearanceDepthRatio;
  const zoneStart = faceStartMm + endClearance;
  const zoneEnd = faceEndMm - endClearance;
  const opening = {
    maxDiameter,
    endClearance,
    minCenterSpacing: BEAM_OPENING_RULES.minCenterSpacingDiameterRatio * maxDiameter,
    zoneStart,
    zoneEnd,
    zoneLength: Math.max(0, zoneEnd - zoneStart),
    centerDepthRatio: BEAM_OPENING_RULES.verticalCenterDepthRatio,
    valid: zoneEnd > zoneStart,
  };

  return {
    index,
    /** 支点配列における始端・終端のインデックス */
    startSupportIndex: supportIndex,
    endSupportIndex: supportIndex + 1,
    girderId: beamEl.getAttribute('id'),
    name: beamEl.getAttribute('name') || null,
    sectionName: sectionDetail.name || null,
    concreteStrength: sectionDetail.concrete?.strength || null,
    startMm,
    endMm,
    faceStartMm,
    faceEndMm,
    clearSpan,
    /** 梁天端レベル [mm]（始端・終端） */
    topLevelStart,
    topLevelEnd,
    /** 接するスラブ（天端＝梁天端。貫通孔はこの範囲を通せない） */
    slab: slab || { depth: 0, name: null },
    /** 基礎梁か（isFoundation属性優先。無い場合は梁名・断面名から推定） */
    isFoundationBeam: resolveIsFoundationBeam(beamEl, sectionDetail.name || null),
    section: {
      width,
      depth,
      positionPattern: sectionDetail.positionPattern,
      start: summarizePosition(startPos),
      center: summarizePosition(centerPos),
      end: summarizePosition(endPos),
    },
    cutoff,
    anchorage,
    opening,
  };
}

/**
 * 柱内定着（のみこみ）寸法を算定する
 * @param {Object} support - 支点データ
 * @param {number} topBarDia - 上端筋呼び径 [mm]
 * @param {number} bottomBarDia - 下端筋呼び径 [mm]
 * @returns {Object|null} 定着寸法（柱が無い場合 null）
 */
function buildAnchorage(support, topBarDia, bottomBarDia) {
  if (!support.hasColumn || !support.depthAlongBeam) return null;
  const columnDepth = support.depthAlongBeam;
  return {
    columnDepth,
    /** 水平投影定着長さ La（柱せいの3/4以上） */
    projectionLa: columnDepth * REBAR_ANCHORAGE_RULES.projectionColumnDepthRatio,
    /** 90°折曲げ後の余長（上端筋・下端筋） */
    tailTop: REBAR_ANCHORAGE_RULES.tailDiaFactor * topBarDia,
    tailBottom: REBAR_ANCHORAGE_RULES.tailDiaFactor * bottomBarDia,
    /** 下端筋を直線定着とする場合の最小のみこみ長さ 15d */
    straightMinBottom: REBAR_ANCHORAGE_RULES.straightBottomDiaFactor * bottomBarDia,
    /** 第1あばら筋の柱面からの距離 */
    firstStirrupFromFace: REBAR_ANCHORAGE_RULES.firstStirrupFromFaceMm,
  };
}

/**
 * 梁立面図データを抽出する
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {string} elementType - 'Girder' または 'Beam'
 * @param {string} elementId - 要素ID
 * @param {Object} [options] - {continuous: 連続梁を辿るか（既定true）}
 * @returns {Object} 立面図データ（エラー時は {error} を含む）
 */
export function extractBeamElevationData(xmlDoc, elementType, elementId, options = {}) {
  if (!xmlDoc) return { error: 'モデルが読み込まれていません' };
  const continuous = options.continuous !== false;

  const scanTag = createTagScanner(xmlDoc);

  // Girder/Beam どちらのタグでも検索（要素情報パネルと同様のフォールバック）
  const tagCandidates =
    elementType === 'Beam' ? ['StbBeam', 'StbGirder'] : ['StbGirder', 'StbBeam'];
  let seedEl = null;
  let resolvedTag = null;
  for (const tag of tagCandidates) {
    seedEl = findElementById(scanTag, tag, elementId);
    if (seedEl) {
      resolvedTag = tag;
      break;
    }
  }
  if (!seedEl) return { error: `梁要素が見つかりません (id=${elementId})` };

  const seedGeometry = getBeamGeometry(scanTag, seedEl);
  if (!seedGeometry) return { error: '梁の節点座標を取得できません' };

  const beamInfo = {
    id: elementId,
    elementType: resolvedTag.replace('Stb', ''),
    name: seedEl.getAttribute('name') || null,
    kindStructure: seedEl.getAttribute('kind_structure') || 'RC',
  };

  // 選択梁の断面（RCのみ対応）
  const seedSection = resolveRcBeamSection(scanTag, seedEl.getAttribute('id_section'));
  if (!seedSection) {
    return {
      error: 'RC梁断面（StbSecBeam_RC / StbSecGirder_RC）が見つかりません。RC梁のみ対応しています',
      beam: beamInfo,
    };
  }

  // 連続梁を辿る（節点の並びが始端→終端になるよう向きを揃える）
  const run = continuous
    ? collectContinuousRun(scanTag, seedEl, resolvedTag, seedGeometry.dir)
    : [seedEl];

  const warnings = [];

  // 支点ノードの並びを作る
  const orderedNodeIds = buildOrderedNodeIds(scanTag, run, seedGeometry.dir);
  if (!orderedNodeIds) return { error: '連続梁の節点並びを解決できません' };

  // 通り芯（座標から照合するため、節点一覧に載らない端部でも解決できる）
  const axisGroups = resolveAxisGroups(scanTag, (nodeId) => getNodeCoord(scanTag, nodeId));
  const { supportGroup, lineGroup } = selectAxisGroups(axisGroups, seedGeometry.dir);
  const lineName = findAxisNameAt(lineGroup, getNodeCoord(scanTag, orderedNodeIds[0]));

  // 支点位置（連続梁始端からの距離）
  const supports = [];
  let cumulative = 0;
  for (let i = 0; i < orderedNodeIds.length; i++) {
    const coord = getNodeCoord(scanTag, orderedNodeIds[i]);
    if (i > 0) {
      const prev = getNodeCoord(scanTag, orderedNodeIds[i - 1]);
      cumulative += Math.hypot(coord.x - prev.x, coord.y - prev.y, coord.z - prev.z);
    }
    supports.push(
      buildSupport(
        scanTag,
        orderedNodeIds[i],
        seedGeometry.dir,
        cumulative,
        findAxisNameAt(supportGroup, coord),
        coord.z,
      ),
    );
  }

  for (const support of supports) {
    if (!support.hasColumn) {
      warnings.push(
        `${support.axisName ? `${support.axisName}通り` : `節点${support.nodeId}`}に柱が見つかりません（節点位置を柱面とみなします）`,
      );
    } else if (!support.depthAlongBeam) {
      warnings.push(
        `${support.axisName ? `${support.axisName}通り` : `節点${support.nodeId}`}の柱断面寸法を取得できません（矩形/円形のみ対応）`,
      );
    }
  }

  // スパンごとの算定
  const spans = [];
  let selectedSpanIndex = null;
  for (let i = 0; i < run.length; i++) {
    const beamEl = run[i];
    const sectionDetail =
      beamEl === seedEl
        ? seedSection
        : resolveRcBeamSection(scanTag, beamEl.getAttribute('id_section'));
    if (!sectionDetail) {
      warnings.push(
        `${beamEl.getAttribute('name') || beamEl.getAttribute('id')} はRC梁でないため省略しました`,
      );
      continue;
    }
    const span = buildSpan({
      beamEl,
      sectionDetail,
      startSupport: supports[i],
      endSupport: supports[i + 1],
      index: spans.length,
      supportIndex: i,
      slab: findAdjacentSlab(
        scanTag,
        beamEl.getAttribute('id_node_start'),
        beamEl.getAttribute('id_node_end'),
      ),
    });
    if (span.section.depth < MIN_DEPTH_MM) {
      warnings.push(`${span.name || span.girderId} の梁せいを取得できません`);
      continue;
    }
    if (span.clearSpan <= 0) {
      warnings.push(
        `${span.name || span.girderId} の内法スパンが算定できません（柱せいがスパンを超えています）`,
      );
      continue;
    }
    // 選択した梁自体がスキップされた場合は、そのことを警告に残す
    if (!span.opening.valid) {
      warnings.push(
        `${span.name || span.girderId} はスパンが短く、貫通孔の配置可能範囲がありません`,
      );
    }
    if (beamEl === seedEl) selectedSpanIndex = spans.length;
    spans.push(span);
  }

  if (spans.length === 0) {
    return { error: '描画できるスパンがありません', beam: beamInfo };
  }

  if (selectedSpanIndex === null) {
    // 選択した梁が算定不能でスキップされた場合、先頭スパンを代表として扱う
    warnings.push('選択した梁は算定できないため、先頭スパンの内容を表示しています');
    selectedSpanIndex = 0;
  }

  const maxDepth = Math.max(...spans.map((s) => s.section.depth));
  const totalLength = supports[supports.length - 1].positionMm;
  // 立面の高さ方向の範囲（段差梁・レベル差を図に反映するため）
  const levelTop = Math.max(...spans.map((s) => Math.max(s.topLevelStart, s.topLevelEnd)));
  const levelBottom = Math.min(
    ...spans.map((s) => Math.min(s.topLevelStart, s.topLevelEnd) - s.section.depth),
  );

  return {
    beam: {
      ...beamInfo,
      sectionName: seedSection.name || null,
      concreteStrength: seedSection.concrete?.strength || null,
      /** 基礎梁か（isFoundation属性優先。無い場合は梁名・断面名から推定） */
      isFoundationBeam: resolveIsFoundationBeam(seedEl, seedSection.name || null),
    },
    axisLine: lineName,
    isContinuous: spans.length > 1,
    selectedSpanIndex,
    totalLength,
    maxDepth,
    levelTop,
    levelBottom,
    supports,
    spans,
    spacingRules: { ...REBAR_SPACING_RULES },
    warnings,
    disclaimer:
      '配置可能範囲・カットオフ位置・定着寸法は一般的な設計指針（孔径≤D/3かつ750mm、柱面から孔中心≥D、' +
      '中心間隔≥3H、カットオフL0/4+15d、投影定着長さLa≥3D/4、余長8d）による目安です。柱せいは通り芯平行配置を' +
      '想定した近似投影で、柱の回転（rotate）・斜め梁の厳密な投影は考慮していません。' +
      '実際の可否は使用する工法の設計指針・構造設計者の判断によります。',
  };
}

/**
 * 連続梁の支点ノードIDを始端から終端の順に並べる
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {Array<Element>} run - 連続する梁要素（順序付き）
 * @param {{x:number,y:number}} dir - 基準方向
 * @returns {Array<string>|null}
 */
function buildOrderedNodeIds(scanTag, run, dir) {
  const nodeIds = [];
  for (let i = 0; i < run.length; i++) {
    const startId = run[i].getAttribute('id_node_start');
    const endId = run[i].getAttribute('id_node_end');
    if (i === 0) {
      // 基準方向に沿う向きで始端・終端を決める
      const startCoord = getNodeCoord(scanTag, startId);
      const endCoord = getNodeCoord(scanTag, endId);
      if (!startCoord || !endCoord) return null;
      const along = (endCoord.x - startCoord.x) * dir.x + (endCoord.y - startCoord.y) * dir.y;
      nodeIds.push(...(along >= 0 ? [startId, endId] : [endId, startId]));
      continue;
    }
    const previousLast = nodeIds[nodeIds.length - 1];
    if (startId === previousLast) {
      nodeIds.push(endId);
    } else if (endId === previousLast) {
      nodeIds.push(startId);
    } else {
      return null;
    }
  }
  return nodeIds;
}
