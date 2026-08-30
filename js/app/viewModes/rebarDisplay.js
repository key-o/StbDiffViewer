/**
 * @fileoverview 3D配筋表示のオーケストレーション
 *
 * STB文書からRC柱・RC梁の断面内配置を求め（data層）、
 * 部材要素・節点に載せて3Dメッシュを生成し（viewer層）、
 * 鉄筋表示グループへ差し込む。
 *
 * 主筋（main）と帯筋・あばら筋（hoop）は独立して切り替えるため、
 * 同じ手順を種別ごとに適用する。
 *
 * ST-Bridgeには鉄筋の3次元位置が含まれないため、表示されるのは
 * かぶり・dt から構成した想定配置である。
 *
 * @module app/viewModes/rebarDisplay
 */

import { createLogger } from '../../utils/logger.js';
import { eventBus } from '../../data/events/eventBus.js';
import { FinalizationEvents } from '../../constants/eventTypes.js';
import { getModelContext } from './modelContext.js';
import { buildColumnRebarLayoutMap } from '../../data/extractors/rebar3d/columnRebarPlacement.js';
import { buildBeamRebarLayoutMaps } from '../../data/extractors/rebar3d/beamRebarPlacement.js';
import { buildBeamAnchorageMaps } from '../../data/extractors/rebar3d/beamAnchoragePlacement.js';
import { buildBeamCutoffMaps } from '../../data/extractors/rebar3d/beamCutoffPlacement.js';
import { buildColumnAnchorageMaps } from '../../data/extractors/rebar3d/columnAnchoragePlacement.js';
import { createTagScanner } from '../../data/extractors/columnSupportUtils.js';
import {
  buildBeamStirrupLayoutMaps,
  buildColumnHoopLayoutMap,
} from '../../data/extractors/rebar3d/hoopPlacement.js';
import {
  createBeamRebarMeshes,
  createBeamStirrupMeshes,
  createColumnHoopMeshes,
  createColumnRebarMeshes,
  createRebarPieceMeshes,
  getRebarDisplayManager,
  parseStbFile,
  requestRender,
  scene,
} from '../../viewer/index.js';

const log = createLogger('rebarDisplay');

/**
 * 種別ごとの配置算定とメッシュ生成の組み合わせ
 * @type {Object<string, {label:string, buildColumnLayouts:Function, buildBeamLayouts:Function, createColumnMeshes:Function, createBeamMeshes:Function}>}
 */
const REBAR_KINDS = {
  main: {
    label: 'RC柱・RC梁の主筋',
    buildColumnLayouts: buildColumnRebarLayoutMap,
    buildBeamLayouts: buildBeamRebarLayoutMaps,
    createColumnMeshes: createColumnRebarMeshes,
    createBeamMeshes: createBeamRebarMeshes,
    /** 主筋は定着（柱内・柱頭・柱脚）とカットオフ筋を続けて描く */
    withAnchorage: true,
  },
  hoop: {
    label: 'RC柱の帯筋・RC梁のあばら筋',
    buildColumnLayouts: buildColumnHoopLayoutMap,
    buildBeamLayouts: buildBeamStirrupLayoutMaps,
    createColumnMeshes: createColumnHoopMeshes,
    createBeamMeshes: createBeamStirrupMeshes,
  },
};

/** 種別ごとの直近に適用した配置設定（モデル再読み込み時の再生成で流用する） */
const lastOptions = { main: {}, hoop: {} };
/** モデル読み込み完了の購読を二重登録しないためのフラグ */
let syncInitialized = false;

/**
 * 1モデル分のメッシュを作る
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {string} modelSource - モデル種別（'A' | 'B'）
 * @param {Object} options - 配置設定（かぶり上書き等）
 * @param {Object} kind - REBAR_KINDS の要素
 * @returns {Array<Object>} 生成メッシュ
 */
function createMeshesForModel(xmlDoc, modelSource, options, kind) {
  if (!xmlDoc) return [];

  const columnLayouts = kind.buildColumnLayouts(xmlDoc, options);
  const beamLayouts = kind.buildBeamLayouts(xmlDoc, options);
  if (columnLayouts.size === 0 && beamLayouts.girder.size === 0 && beamLayouts.beam.size === 0) {
    log.info(`[Render] モデル${modelSource}: ${kind.label}の配筋情報が見つかりません`);
    return [];
  }

  const stbData = parseStbFile(xmlDoc, { modelKey: modelSource });
  const nodes = stbData?.nodes;
  const girderElements = stbData?.girderElements || [];
  const beamElements = stbData?.beamElements || [];

  // 大梁と小梁は断面IDの採番空間が独立しているため、それぞれの配置マップで生成する
  const meshes = [
    ...kind.createColumnMeshes(stbData?.columnElements || [], nodes, columnLayouts, {
      modelSource,
    }),
    ...kind.createBeamMeshes(girderElements, nodes, beamLayouts.girder, { modelSource }),
    ...kind.createBeamMeshes(beamElements, nodes, beamLayouts.beam, { modelSource }),
  ];

  if (kind.withAnchorage) {
    const columnElements = stbData?.columnElements || [];
    // 3つのマップ生成で全文書タグスキャンを共有する
    const scanTag = createTagScanner(xmlDoc);
    const anchorages = buildBeamAnchorageMaps(xmlDoc, beamLayouts, options, scanTag);
    const cutoffs = buildBeamCutoffMaps(xmlDoc, beamLayouts, scanTag);
    const columnAnchorages = buildColumnAnchorageMaps(xmlDoc, columnLayouts, options, scanTag);

    const pieceSources = [
      { elements: girderElements, layouts: beamLayouts.girder, pieces: anchorages.girder },
      { elements: beamElements, layouts: beamLayouts.beam, pieces: anchorages.beam },
      { elements: girderElements, layouts: beamLayouts.girder, pieces: cutoffs.girder },
      { elements: beamElements, layouts: beamLayouts.beam, pieces: cutoffs.beam },
    ];
    for (const source of pieceSources) {
      meshes.push(
        ...createRebarPieceMeshes(source.elements, nodes, source.layouts, source.pieces, {
          modelSource,
          rebarKind: 'beamAnchorage',
        }),
      );
    }
    meshes.push(
      ...createRebarPieceMeshes(columnElements, nodes, columnLayouts, columnAnchorages.columns, {
        modelSource,
        rebarKind: 'columnAnchorage',
        memberType: 'column',
      }),
    );
  }
  return meshes;
}

/**
 * 定着・カットオフ筋長さの判定結果を集める（3D表示の有無に依存しない）
 *
 * 梁主筋の柱内定着（§8-2）・柱主筋の定着（§7-3）・柱／梁のカットオフ筋長さ
 * （§7-1 / §8-1 / §9-1）をまとめて返す。
 * @param {Object} [options] - 算定設定
 * @param {number} [options.coverMm] - 梁のかぶり厚さの上書き [mm]
 * @param {number} [options.columnCoverMm] - 柱のかぶり厚さの上書き [mm]
 * @returns {Array<Object>} 判定行（モデル種別 modelSource を含む）
 */
export function collectRebarAnchorageChecks(options = {}) {
  const { modelADocument, modelBDocument } = getModelContext();
  const checks = [];

  for (const [modelSource, xmlDoc] of [
    ['A', modelADocument],
    ['B', modelBDocument],
  ]) {
    if (!xmlDoc) continue;

    const beamLayouts = buildBeamRebarLayoutMaps(xmlDoc, options);
    const columnLayouts = buildColumnRebarLayoutMap(xmlDoc, options);
    const modelChecks = [];
    const scanTag = createTagScanner(xmlDoc);
    if (beamLayouts.girder.size > 0 || beamLayouts.beam.size > 0) {
      modelChecks.push(
        ...buildBeamAnchorageMaps(xmlDoc, beamLayouts, options, scanTag).checks,
        ...buildBeamCutoffMaps(xmlDoc, beamLayouts, scanTag).checks,
      );
    }
    if (columnLayouts.size > 0) {
      modelChecks.push(...buildColumnAnchorageMaps(xmlDoc, columnLayouts, options, scanTag).checks);
    }
    checks.push(...modelChecks.map((check) => ({ modelSource, ...check })));
  }
  return checks;
}

/**
 * 3D配筋を再生成する
 *
 * @param {Object} [options] - 配置設定
 * @param {number} [options.coverMm] - かぶり厚さの上書き [mm]
 * @param {string} [kindKey] - 'main' | 'hoop'
 * @returns {number} 生成したメッシュ数
 */
function rebuildRebarDisplay(options = {}, kindKey = 'main') {
  const manager = getRebarDisplayManager(scene);
  const kind = REBAR_KINDS[kindKey];
  if (!manager || !kind) {
    log.warn('RebarDisplayManagerが初期化されていません');
    return 0;
  }

  lastOptions[kindKey] = options;
  const { modelADocument, modelBDocument } = getModelContext();
  const meshes = [
    ...createMeshesForModel(modelADocument, 'A', options, kind),
    ...createMeshesForModel(modelBDocument, 'B', options, kind),
  ];

  manager.setMeshes(meshes, kindKey);
  requestRender();
  return meshes.length;
}

/**
 * 3D配筋の表示/非表示を切り替える
 *
 * 表示に切り替えたときにメッシュが無ければ生成する。
 * @param {boolean} visible - 表示するか
 * @param {Object} [options] - 配置設定（rebuild時に使用）
 * @param {string} [kindKey] - 'main' | 'hoop'
 * @returns {boolean} 実際に表示できたか
 */
export function setRebarDisplayVisible(visible, options = {}, kindKey = 'main') {
  const manager = getRebarDisplayManager(scene);
  if (!manager || !REBAR_KINDS[kindKey]) {
    log.warn('RebarDisplayManagerが初期化されていません');
    return false;
  }

  if (!visible) {
    manager.setVisible(false, kindKey);
    requestRender();
    return false;
  }

  // rebuildRebarDisplay が再描画を要求するため、ここでは要求しない
  const meshCount = rebuildRebarDisplay(options, kindKey);
  manager.setVisible(meshCount > 0, kindKey);
  return meshCount > 0;
}

/**
 * 3D配筋メッシュを破棄する（モデル再読み込み時など）
 * @param {string} [kindKey] - 種別。省略時は全種別
 */
function clearRebarDisplay(kindKey = null) {
  const manager = getRebarDisplayManager(scene);
  if (manager) manager.clear(kindKey);
}

/**
 * モデル読み込み完了時に3D配筋を追従させる購読を開始する。
 *
 * 表示中の種別のみ直近の設定で作り直し、非表示なら古いメッシュを捨てるだけにする。
 * @param {Function} [onHidden] - 新モデルに配筋が無く非表示へ戻したときの通知（種別キーを渡す）
 */
export function initializeRebarDisplaySync(onHidden = null) {
  if (syncInitialized) return;
  syncInitialized = true;

  eventBus.on(FinalizationEvents.COMPLETED, () => {
    const manager = getRebarDisplayManager(scene);
    if (!manager) return;

    for (const kindKey of Object.keys(REBAR_KINDS)) {
      if (!manager.isVisible(kindKey)) {
        clearRebarDisplay(kindKey);
        continue;
      }
      if (!setRebarDisplayVisible(true, lastOptions[kindKey], kindKey) && onHidden) {
        onHidden(kindKey);
      }
    }
  });
}
