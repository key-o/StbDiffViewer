/**
 * @fileoverview RC柱断面リスト用データ抽出モジュール
 *
 * STBファイルからRC柱断面リストに必要なデータを抽出し、
 * 階別・符号別にグループ化した構造を返します。
 * STB v2.0.2と v2.1の両方に対応しており、バージョンごとに
 * 異なるパーサーロジックを使用します。
 *
 * @module data/extractors/columnSectionListExtractor
 */

import {
  isVersion210,
  isVersion202,
} from '../../common-stb/import/parser/utils/stbVersionDetection.js';
import { STB_TAG_NAMES } from '../../constants/elementTypes.js';
import {
  querySelector,
  querySelectorAll,
  extractStories,
  compareStoriesDescending,
  extractBaseSymbol,
  compareSymbols,
} from './sectionListUtils.js';
import { createLogger } from '../../utils/logger.js';
import { resolveReinforcementStrength } from './reinforcementStrengthResolver.js';

const log = createLogger('data:extractors:columnSectionListExtractor');

/**
 * StbColumn一覧を抽出（RC柱のみ）
 * @param {Document} xmlDoc - XMLドキュメント
 * @returns {Array<Object>} 柱要素情報配列
 */
function extractColumns(xmlDoc) {
  const columns = [];
  const columnElements = querySelectorAll(xmlDoc, STB_TAG_NAMES.COLUMN);

  columnElements.forEach((el) => {
    const id = el.getAttribute('id');
    const idSection = el.getAttribute('id_section');
    const name = el.getAttribute('name');
    const kindColumn = el.getAttribute('kind_column');
    const kindStructure = el.getAttribute('kind_structure');
    const idNodeBottom = el.getAttribute('id_node_bottom');
    const idNodeTop = el.getAttribute('id_node_top');

    // POST（間柱）は除外
    if (kindColumn === 'POST') return;

    // RC柱断面リストでは、明示的にRC以外とされた柱を使用実績に含めない。
    // kind_structure未記載の旧データは後方互換のため従来どおり許容する。
    if (kindStructure && kindStructure.toUpperCase() !== 'RC') return;

    if (id && idSection) {
      columns.push({
        id,
        idSection,
        name,
        idNodeBottom,
        idNodeTop,
      });
    }
  });

  return columns;
}

/**
 * 柱が属する階を取得
 * @param {Object} column - 柱情報
 * @param {Map<string, Object>} stories - Story情報マップ
 * @returns {Array<string>} 階IDの配列
 */
function getStoryIdsForColumn(column, stories) {
  const bottomStoryIds = [];
  const topStoryIds = [];

  stories.forEach((story, storyId) => {
    if (story.nodeIds.has(column.idNodeBottom)) {
      bottomStoryIds.push(storyId);
    }
    if (story.nodeIds.has(column.idNodeTop)) {
      topStoryIds.push(storyId);
    }
  });

  // 柱は下端階に所属させる。下端が取れない場合のみ上端階をフォールバックで採用する。
  if (bottomStoryIds.length > 0) {
    const sorted = [...bottomStoryIds].sort((a, b) => {
      const levelA = stories.get(a)?.level ?? Number.POSITIVE_INFINITY;
      const levelB = stories.get(b)?.level ?? Number.POSITIVE_INFINITY;
      return levelA - levelB;
    });
    return [sorted[0]];
  }

  if (topStoryIds.length > 0) {
    const sorted = [...topStoryIds].sort((a, b) => {
      const levelA = stories.get(a)?.level ?? Number.NEGATIVE_INFINITY;
      const levelB = stories.get(b)?.level ?? Number.NEGATIVE_INFINITY;
      return levelB - levelA;
    });
    return [sorted[0]];
  }

  return [];
}

/**
 * StbSecColumn_RCの詳細情報を抽出
 * @param {Element} sectionElement - StbSecColumn_RC要素
 * @returns {Object} 断面詳細データ
 */
function extractRcColumnSectionDetail(sectionElement) {
  const id = sectionElement.getAttribute('id');
  const name = sectionElement.getAttribute('name');
  const strengthConcrete = sectionElement.getAttribute('strength_concrete') || null;

  const result = {
    id,
    name,
    concrete: {
      strength: strengthConcrete,
    },
    dimensions: {},
    arrangements: [],
    mainBar: createEmptyMainBar(),
    hoop: createEmptyHoop(),
    coreBar: null,
    cover: null,
  };

  // 寸法情報を抽出（矩形または円形）
  // SS7生成: StbSecFigureColumn_RC > StbSecColumnRect / StbSecColumnCircle
  const rectFigure =
    querySelector(sectionElement, 'StbSecColumn_RC_Rect') ||
    querySelector(querySelector(sectionElement, 'StbSecFigure'), 'StbSecColumn_RC_Rect') ||
    querySelector(querySelector(sectionElement, 'StbSecFigureColumn_RC'), 'StbSecColumnRect') ||
    querySelector(sectionElement, 'StbSecColumnRect');

  const circleFigure =
    querySelector(sectionElement, 'StbSecColumn_RC_Circle') ||
    querySelector(querySelector(sectionElement, 'StbSecFigure'), 'StbSecColumn_RC_Circle') ||
    querySelector(querySelector(sectionElement, 'StbSecFigureColumn_RC'), 'StbSecColumnCircle') ||
    querySelector(sectionElement, 'StbSecColumnCircle');

  if (rectFigure) {
    result.dimensions.type = 'RECTANGLE';
    result.dimensions.width =
      parseFloat(rectFigure.getAttribute('width_X') || rectFigure.getAttribute('depth_X')) || 0;
    result.dimensions.height =
      parseFloat(rectFigure.getAttribute('width_Y') || rectFigure.getAttribute('depth_Y')) || 0;
  } else if (circleFigure) {
    result.dimensions.type = 'CIRCLE';
    result.dimensions.diameter = parseFloat(circleFigure.getAttribute('D')) || 0;
  }

  // 配筋情報を抽出。Simple形式のSame/NotSameを柱頭・柱脚別に全件保持する。
  const barArrangement = querySelector(sectionElement, 'StbSecBarArrangementColumn_RC');
  if (barArrangement) {
    const isCircular = result.dimensions.type === 'CIRCLE';
    const barElements = collectSimpleBarElements(barArrangement, isCircular);
    result.arrangements = barElements.map(({ element, defaultPosition }) =>
      isCircular
        ? extractCircleBarInfo(element, barArrangement, defaultPosition)
        : extractRectBarInfo(element, barArrangement, defaultPosition),
    );

    const preferred = selectPreferredArrangement(result.arrangements);
    if (preferred) {
      result.mainBar = preferred.mainBar;
      result.hoop = preferred.hoop;
      result.coreBar = preferred.coreBar;
      result.cover = preferred.cover;
    }
  }

  return result;
}

function createEmptyMainBar() {
  return {
    countX: 0,
    countY: 0,
    countTotal: 0,
    count: 0,
    dia: null,
    diaSub: null,
    grade: null,
    gradeSub: null,
    mainDirection: 'X',
    layers: [],
    firstLayerExtraGroups: [],
    secondLayer: null,
    centerStartX: null,
    centerEndX: null,
    centerStartY: null,
    centerEndY: null,
    dtX: null,
    dtY: null,
    dt: null,
  };
}

function createEmptyHoop() {
  return {
    dia: null,
    pitch: 0,
    grade: null,
    countX: 0,
    countY: 0,
  };
}

function readAttribute(element, fallbackElement, ...names) {
  for (const source of [element, fallbackElement]) {
    if (!source) continue;
    for (const name of names) {
      const value = source.getAttribute(name);
      if (value !== null && value !== '') return value;
    }
  }
  return null;
}

function readNumber(element, fallbackElement, ...names) {
  const value = readAttribute(element, fallbackElement, ...names);
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readInteger(element, fallbackElement, ...names) {
  const value = readAttribute(element, fallbackElement, ...names);
  if (value === null) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeBarPosition(value, defaultPosition) {
  const normalized = String(value || defaultPosition || 'SAME').toUpperCase();
  if (normalized === 'TOP') return 'TOP';
  if (normalized === 'BOTTOM' || normalized === 'BASE') return 'BOTTOM';
  return 'SAME';
}

function collectSimpleBarElements(barArrangement, isCircular) {
  const legacySame = isCircular
    ? ['StbSecBarColumn_RC_CircleSame', 'StbSecBarColumn_RC_Circle']
    : ['StbSecBarColumn_RC_RectSame', 'StbSecBarColumn_RC_Rect'];
  const legacyNotSame = isCircular
    ? ['StbSecBarColumn_RC_CircleNotSame']
    : ['StbSecBarColumn_RC_RectNotSame'];
  const modernWrappers = isCircular
    ? [
        ['StbSecBarColumnCircleSame', 'StbSecBarColumnCircleSameSimple', 'SAME'],
        ['StbSecBarColumnCircleNotSame', 'StbSecBarColumnCircleNotSameSimple', null],
      ]
    : [
        ['StbSecBarColumnRectSame', 'StbSecBarColumnRectSameSimple', 'SAME'],
        ['StbSecBarColumnRectNotSame', 'StbSecBarColumnRectNotSameSimple', null],
      ];

  const collected = [];
  const seen = new Set();
  const add = (element, defaultPosition) => {
    if (!element || seen.has(element)) return;
    seen.add(element);
    collected.push({ element, defaultPosition });
  };

  legacySame.forEach((selector) => {
    querySelectorAll(barArrangement, selector).forEach((element) => add(element, 'SAME'));
  });
  legacyNotSame.forEach((selector) => {
    querySelectorAll(barArrangement, selector).forEach((element) => add(element, null));
  });
  modernWrappers.forEach(([wrapperSelector, simpleSelector, defaultPosition]) => {
    querySelectorAll(barArrangement, wrapperSelector).forEach((wrapper) => {
      const simpleElements = querySelectorAll(wrapper, simpleSelector);
      if (simpleElements.length > 0) {
        simpleElements.forEach((element) => add(element, defaultPosition));
      } else if (readAttribute(wrapper, null, 'D_main', 'N_X', 'N_main')) {
        add(wrapper, defaultPosition);
      }
    });
  });

  return collected;
}

function selectPreferredArrangement(arrangements) {
  const priority = ['BOTTOM', 'SAME', 'TOP'];
  for (const position of priority) {
    const arrangement = arrangements.find((candidate) => candidate.position === position);
    if (arrangement) return arrangement;
  }
  return arrangements[0] || null;
}

function extractCoreBar(barElement, fallbackElement) {
  const total = readInteger(barElement, fallbackElement, 'N_axial', 'N_core', 'N_main_core');
  if (total <= 0) return null;

  const dia = readAttribute(barElement, fallbackElement, 'D_axial', 'D_core', 'D_main_core');
  const explicitGrade = readAttribute(
    barElement,
    fallbackElement,
    'strength_axial',
    'strength_core',
  );
  const grade = resolveReinforcementStrength({
    element: barElement,
    diameter: dia,
    explicitStrength: explicitGrade,
  }).value;
  return {
    total,
    dia: dia ? dia.toUpperCase() : null,
    grade,
    placementEstimated: true,
  };
}

function extractRectCoverFaces(barElement, fallbackElement) {
  const faces = {
    startX: readNumber(barElement, fallbackElement, 'depth_cover_start_X'),
    endX: readNumber(barElement, fallbackElement, 'depth_cover_end_X'),
    startY: readNumber(barElement, fallbackElement, 'depth_cover_start_Y'),
    endY: readNumber(barElement, fallbackElement, 'depth_cover_end_Y'),
  };
  return Object.values(faces).every((value) => value === null) ? null : faces;
}

function attachRectCoverFaces(arrangement, coverFaces) {
  Object.defineProperty(arrangement, 'coverFaces', {
    value: coverFaces,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return arrangement;
}

function extractCover(barElement, fallbackElement, isCircular) {
  if (isCircular) {
    return readNumber(barElement, fallbackElement, 'depth_cover');
  }

  const values = [
    readNumber(barElement, fallbackElement, 'depth_cover_start_X'),
    readNumber(barElement, fallbackElement, 'depth_cover_end_X'),
    readNumber(barElement, fallbackElement, 'depth_cover_start_Y'),
    readNumber(barElement, fallbackElement, 'depth_cover_end_Y'),
  ].filter((value) => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 矩形配筋情報を抽出
 * @param {Element} rectBar - StbSecBarColumn_RC_Rect/RectSame/RectNotSame要素
 * @param {Object} result - 結果オブジェクト
 */
function extractRectBarInfo(rectBar, barArrangement, defaultPosition) {
  // 主筋本数（X方向）- フォールバック（v2.0.2 → v1.x → SS7生成 → 旧版）
  const nMainX =
    parseInt(
      readAttribute(rectBar, barArrangement, 'N_main_X_1st', 'N_main_X', 'N_X', 'count_main_X'),
    ) || 0;

  // 主筋本数（Y方向）- フォールバック（v2.0.2 → v1.x → SS7生成 → 旧版）
  const nMainY =
    parseInt(
      readAttribute(rectBar, barArrangement, 'N_main_Y_1st', 'N_main_Y', 'N_Y', 'count_main_Y'),
    ) || 0;

  // 主筋径
  const dMain = readAttribute(rectBar, barArrangement, 'D_main', 'dia_main');
  const dSub = readAttribute(rectBar, barArrangement, 'D_sub');
  const gradeMain = resolveReinforcementStrength({
    element: rectBar,
    diameter: dMain,
    explicitStrength: readAttribute(rectBar, barArrangement, 'strength_main', 'grade_main'),
  }).value;
  const gradeSub = resolveReinforcementStrength({
    element: rectBar,
    diameter: dSub,
    explicitStrength: readAttribute(rectBar, barArrangement, 'strength_sub'),
  }).value;
  const mainDirection =
    readAttribute(rectBar, barArrangement, 'main_direction')?.toUpperCase() === 'Y' ? 'Y' : 'X';
  const countTotalAttribute = readInteger(rectBar, barArrangement, 'N_main_total');
  const countTotal =
    countTotalAttribute || (nMainX > 0 && nMainY > 0 ? 2 * (nMainX + nMainY) - 4 : 0);
  const centerStartX = readNumber(rectBar, barArrangement, 'center_start_X');
  const centerEndX = readNumber(rectBar, barArrangement, 'center_end_X');
  const centerStartY = readNumber(rectBar, barArrangement, 'center_start_Y');
  const centerEndY = readNumber(rectBar, barArrangement, 'center_end_Y');
  const legacyDtX = readNumber(rectBar, barArrangement, 'D1_X', 'center_X');
  const legacyDtY = readNumber(rectBar, barArrangement, 'D1_Y', 'center_Y');
  const dtX = legacyDtX ?? averageDefined(centerStartX, centerEndX);
  const dtY = legacyDtY ?? averageDefined(centerStartY, centerEndY);
  const layers = extractBarLayers(rectBar, barArrangement, dMain, gradeMain, nMainX, nMainY);
  const secondLayerData = layers.find((layer) => layer.step === 2) || null;
  const secondLayer = secondLayerData
    ? {
        ...secondLayerData.groups[0],
        groups: secondLayerData.groups,
        countTotal: secondLayerData.groups.reduce(
          (sum, group) => sum + estimatePerimeterBarCount(group.countX, group.countY),
          0,
        ),
        centerInterval: readNumber(rectBar, barArrangement, 'center_interval'),
        clearInterval: readNumber(rectBar, barArrangement, 'interval'),
        placementEstimated:
          readNumber(rectBar, barArrangement, 'center_interval', 'interval') === null,
      }
    : null;

  const mainBar = {
    countX: nMainX,
    countY: nMainY,
    countTotal,
    count: countTotal,
    dia: dMain ? dMain.toUpperCase() : null,
    diaSub: dSub ? dSub.toUpperCase() : null,
    grade: gradeMain,
    gradeSub,
    mainDirection,
    centerStartX,
    centerEndX,
    centerStartY,
    centerEndY,
    dtX,
    dtY,
    dt: null,
    layers,
    firstLayerExtraGroups: layers[0]?.groups.slice(1) || [],
    secondLayer,
  };

  // 帯筋径 - D_bandを最優先（v2.0.2）
  const dStirrup = readAttribute(
    rectBar,
    barArrangement,
    'D_band',
    'D_stirrup',
    'D_hoop',
    'dia_band',
  );

  // 帯筋ピッチ - pitch_bandを最優先（v2.0.2）
  const pitchStirrup =
    readNumber(rectBar, barArrangement, 'pitch_band', 'pitch_stirrup', 'pitch_hoop', 'pitch') ?? 0;

  // 帯筋強度 - strength_bandを最優先（v2.0.2）
  const gradeStirrup = resolveReinforcementStrength({
    element: rectBar,
    diameter: dStirrup,
    explicitStrength: readAttribute(
      rectBar,
      barArrangement,
      'strength_band',
      'grade_band',
      'strength_stirrup',
      'strength_hoop',
      'grade_stirrup',
    ),
  }).value;

  // 帯筋のX/Y方向本数を取得
  const nBandX =
    parseInt(
      readAttribute(rectBar, barArrangement, 'N_hoop_X', 'N_band_direction_X', 'N_band_X'),
    ) || 0;

  const nBandY =
    parseInt(
      readAttribute(rectBar, barArrangement, 'N_hoop_Y', 'N_band_direction_Y', 'N_band_Y'),
    ) || 0;

  const hoop = {
    dia: dStirrup ? dStirrup.toUpperCase() : null,
    pitch: pitchStirrup,
    grade: gradeStirrup,
    countX: nBandX,
    countY: nBandY,
  };

  // 2種類の帯筋がある場合
  const dStirrup2 = readAttribute(rectBar, barArrangement, 'D_stirrup_2', 'D_hoop_2');
  const pitchStirrup2 = readNumber(rectBar, barArrangement, 'pitch_2', 'pitch_band_2');
  if (dStirrup2 && pitchStirrup2) {
    hoop.dia2 = dStirrup2.toUpperCase();
    hoop.pitch2 = pitchStirrup2;
  }

  return attachRectCoverFaces(
    {
      position: normalizeBarPosition(rectBar.getAttribute('pos'), defaultPosition),
      mainBar,
      hoop,
      coreBar: extractCoreBar(rectBar, barArrangement),
      cover: extractCover(rectBar, barArrangement, false),
    },
    extractRectCoverFaces(rectBar, barArrangement),
  );
}

function extractBarLayers(rectBar, barArrangement, dMain, gradeMain, nMainX, nMainY) {
  const alternateDia = readAttribute(rectBar, barArrangement, 'D_2nd_main');
  const alternateGrade = resolveReinforcementStrength({
    element: rectBar,
    diameter: alternateDia,
    explicitStrength: readAttribute(rectBar, barArrangement, 'strength_2nd_main'),
  }).value;
  const firstAlternateX = readInteger(rectBar, barArrangement, 'N_2nd_main_X_1st');
  const firstAlternateY = readInteger(rectBar, barArrangement, 'N_2nd_main_Y_1st');
  const mainCountX = readInteger(rectBar, barArrangement, 'N_main_X_2nd');
  const mainCountY = readInteger(rectBar, barArrangement, 'N_main_Y_2nd');
  const alternateCountX = readInteger(rectBar, barArrangement, 'N_2nd_main_X_2nd');
  const alternateCountY = readInteger(rectBar, barArrangement, 'N_2nd_main_Y_2nd');
  const group = (countX, countY, dia, grade) => ({
    countX,
    countY,
    dia: dia?.toUpperCase() || null,
    grade: grade || null,
  });
  const layers = [];
  const firstGroups = [];
  if (nMainX > 0 || nMainY > 0) firstGroups.push(group(nMainX, nMainY, dMain, gradeMain));
  if (firstAlternateX > 0 || firstAlternateY > 0) {
    firstGroups.push(group(firstAlternateX, firstAlternateY, alternateDia, alternateGrade));
  }
  if (firstGroups.length > 0) layers.push({ step: 1, groups: firstGroups });

  const secondGroups = [];
  if (mainCountX > 0 || mainCountY > 0) {
    secondGroups.push(group(mainCountX, mainCountY, dMain, gradeMain));
  }
  if (alternateCountX > 0 || alternateCountY > 0) {
    secondGroups.push(group(alternateCountX, alternateCountY, alternateDia, alternateGrade));
  }
  if (secondGroups.length > 0) layers.push({ step: 2, groups: secondGroups });
  return layers;
}

function estimatePerimeterBarCount(countX, countY) {
  if (countX > 0 && countY > 0) return 2 * (countX + countY) - 4;
  return 2 * Math.max(countX, countY, 0);
}

function averageDefined(first, second) {
  const values = [first, second].filter((value) => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 円形配筋情報を抽出
 * @param {Element} circleBar - StbSecBarColumn_RC_Circle/CircleSame/CircleNotSame要素
 * @param {Object} result - 結果オブジェクト
 */
function extractCircleBarInfo(circleBar, barArrangement, defaultPosition) {
  // 主筋本数 - 3段階フォールバック（v2.0.2 → v1.x → 旧版）
  const nMain =
    parseInt(readAttribute(circleBar, barArrangement, 'N_main_1st', 'N_main', 'count_main')) || 0;

  // 主筋径
  const dMain = readAttribute(circleBar, barArrangement, 'D_main', 'dia_main');
  const gradeMain = resolveReinforcementStrength({
    element: circleBar,
    diameter: dMain,
    explicitStrength: readAttribute(circleBar, barArrangement, 'strength_main', 'grade_main'),
  }).value;
  const center = readNumber(circleBar, barArrangement, 'D1', 'center');

  const mainBar = {
    countX: 0,
    countY: 0,
    countTotal: nMain,
    count: nMain,
    dia: dMain ? dMain.toUpperCase() : null,
    diaSub: null,
    grade: gradeMain,
    gradeSub: null,
    mainDirection: null,
    layers: [],
    firstLayerExtraGroups: [],
    secondLayer: null,
    centerStartX: null,
    centerEndX: null,
    centerStartY: null,
    centerEndY: null,
    dtX: null,
    dtY: null,
    dt: center,
  };

  // 帯筋径 - D_bandを最優先（v2.0.2）
  const dStirrup = readAttribute(
    circleBar,
    barArrangement,
    'D_band',
    'D_stirrup',
    'D_hoop',
    'dia_band',
  );

  // 帯筋ピッチ - pitch_bandを最優先（v2.0.2）
  const pitchStirrup =
    readNumber(circleBar, barArrangement, 'pitch_band', 'pitch_stirrup', 'pitch_hoop', 'pitch') ??
    0;

  // 帯筋強度 - strength_bandを最優先（v2.0.2）
  const gradeStirrup = resolveReinforcementStrength({
    element: circleBar,
    diameter: dStirrup,
    explicitStrength: readAttribute(
      circleBar,
      barArrangement,
      'strength_band',
      'grade_band',
      'strength_stirrup',
      'strength_hoop',
      'grade_stirrup',
    ),
  }).value;

  const hoop = {
    dia: dStirrup ? dStirrup.toUpperCase() : null,
    pitch: pitchStirrup,
    grade: gradeStirrup,
    countX: readInteger(circleBar, barArrangement, 'N_hoop_X', 'N_band_direction_X'),
    countY: readInteger(circleBar, barArrangement, 'N_hoop_Y', 'N_band_direction_Y'),
  };

  return {
    position: normalizeBarPosition(circleBar.getAttribute('pos'), defaultPosition),
    mainBar,
    hoop,
    coreBar: extractCoreBar(circleBar, barArrangement),
    cover: extractCover(circleBar, barArrangement, true),
  };
}

/**
 * 全StbSecColumn_RCを抽出
 * @param {Document} xmlDoc - XMLドキュメント
 * @returns {Map<string, Object>} id → 断面詳細データ
 */
export function extractRcColumnSections(xmlDoc) {
  const sections = new Map();
  const sectionElements = querySelectorAll(xmlDoc, 'StbSecColumn_RC');

  sectionElements.forEach((el) => {
    const sectionData = extractRcColumnSectionDetail(el);
    if (sectionData && sectionData.id) {
      sections.set(sectionData.id, sectionData);
    }
  });

  return sections;
}

/**
 * RC柱断面リスト用のデータを抽出・グループ化（階×符号の組み合わせごと）
 * STB v2.0.2と v2.1.0の両方に対応
 * @param {Document} xmlDoc - XMLドキュメント
 * @returns {Object} 断面リストデータ
 */
export function extractColumnSectionList(xmlDoc) {
  if (!xmlDoc) {
    return {
      stories: [],
      sections: [],
      data: {},
    };
  }

  log.info('[extractColumnSectionList] Starting extraction...');

  // バージョンを検出
  const isV210 = isVersion210(xmlDoc);
  const isV202 = isVersion202(xmlDoc);

  log.info('[extractColumnSectionList] STB Version detected:', { isV210, isV202 });

  // バージョンに応じてラベルを決定
  let parserVersion;
  if (isV210) {
    parserVersion = 'v2.1.0';
  } else if (isV202) {
    parserVersion = 'v2.0.2';
  } else {
    log.warn('[extractColumnSectionList] Unknown STB version, using fallback parser');
    parserVersion = 'fallback';
  }

  return buildColumnSectionList(xmlDoc, parserVersion);
}

/**
 * カラム断面リストを構築（バージョン非依存ロジック）
 * @param {Document} xmlDoc - XMLドキュメント
 * @param {string} parserVersion - パーサーバージョン
 * @returns {Object} 断面リストデータ
 */
function buildColumnSectionList(xmlDoc, _parserVersion) {
  // 基本データを抽出
  const stories = extractStories(xmlDoc);
  const columns = extractColumns(xmlDoc);
  const sections = extractRcColumnSections(xmlDoc);

  // 断面IDと階の紐付けを構築
  // sectionId → [{ storyId, storyName, storyLevel }]
  const sectionStoryMap = new Map();

  columns.forEach((column) => {
    const { idSection } = column;
    if (!idSection) return;

    // この柱が属する階を取得（ノードから判定）
    const storyIds = getStoryIdsForColumn(column, stories);

    if (storyIds.length === 0) return;

    if (!sectionStoryMap.has(idSection)) {
      sectionStoryMap.set(idSection, []);
    }

    const existing = sectionStoryMap.get(idSection);

    // 重複チェック＆追加
    storyIds.forEach((storyId) => {
      if (!existing.find((s) => s.id === storyId)) {
        const story = stories.get(storyId);
        if (story) {
          existing.push({
            id: storyId,
            name: story.name,
            level: story.level,
          });
        }
      }
    });
  });

  // 階を降順（上から下、高さレベル基準）にソート
  const sortedStories = Array.from(stories.values()).sort(compareStoriesDescending);

  // 階×符号の組み合わせごとに一行を構築
  const sectionRows = [];

  // 各断面について処理
  sections.forEach((section, sectionId) => {
    const storyUsages = sectionStoryMap.get(sectionId) || [];
    if (storyUsages.length === 0) return;

    const symbol = extractBaseSymbol(section.name);

    // この断面が使用されている各階について一行を作成
    storyUsages.forEach((story) => {
      const sectionForRender = convertSectionForRender(section, [story]);

      sectionRows.push({
        storyId: story.id,
        storyName: story.name,
        storyLevel: story.level,
        symbol: symbol,
        sectionData: sectionForRender,
      });
    });
  });

  // ソート: 階（上から下、高さレベル基準）→ 符号（自然順）
  sectionRows.sort((a, b) => {
    const storyComp = compareStoriesDescending(
      { level: a.storyLevel, name: a.storyName },
      { level: b.storyLevel, name: b.storyName },
    );
    if (storyComp !== 0) return storyComp;
    return compareSymbols(a.symbol, b.symbol); // 符号：昇順
  });

  // dataオブジェクトを構築（旧互換用）
  const data = {};
  sectionRows.forEach((row) => {
    const key = `${row.storyName}-${row.symbol}`;
    data[key] = row.sectionData;
  });

  return {
    stories: sortedStories,
    sections: sectionRows,
    data,
  };
}

/**
 * 断面データをレンダリング用の形式に変換
 * @param {Object} section - 抽出した断面データ
 * @param {Array<Object>} storyUsages - 階使用情報
 * @returns {Object} レンダリング用断面データ
 */
function convertSectionForRender(section, storyUsages) {
  const { id, name, concrete, dimensions, arrangements, mainBar, hoop, coreBar, cover } = section;

  // 符号名リストを生成（例: "10C1, 9C1"）- 降順（上階から）
  // story名の末尾サフィックス（SL, F, 階等）を除去し、section名の階プレフィックス（B1, 1 等）を除去して結合
  // 例: story="B1SL" + section="B1C1" → "B1" + "C1" = "B1C1"
  //     story="1SL"  + section="C1"   → "1"  + "C1" = "1C1"
  const storyNames = storyUsages
    .sort((a, b) => (b.level || 0) - (a.level || 0))
    .map((s) => {
      const storyPrefix = s.name.replace(/(?:SL|FL|F|階)+$/i, '');
      const sectionBase = name.replace(/^B?\d+/, '');
      return storyPrefix + sectionBase;
    })
    .join(', ');

  // SVGレンダラー用のデータ形式
  const renderData = {
    id,
    name,
    symbolNames: storyNames,
    storyUsages,

    // コンクリート
    concrete: {
      strength: concrete.strength,
    },

    // 寸法（SVGレンダラー用）
    width: dimensions.width || 0,
    height: dimensions.height || 0,
    diameter: dimensions.diameter || 0,
    isCircular: dimensions.type === 'CIRCLE',

    // 配筋（柱頭・柱脚別）
    arrangements,

    // 優先配筋の明示かぶり。欠損時は推定値を作らない。
    cover,

    // 優先配筋（BOTTOM → SAME → TOP）を後方互換用トップレベルへミラー
    mainBar,
    hoop,
    coreBar,

    // 元データ（詳細表示用）
    raw: section,
  };

  return renderData;
}

/**
 * RC柱断面リスト用のデータをグリッド形式で抽出・整理
 * 階を行、符号を列とした2次元グリッド構造を返します
 * @param {Document} xmlDoc - XMLドキュメント
 * @returns {Object} グリッド形式の断面リストデータ
 */
export function extractColumnSectionGrid(xmlDoc) {
  if (!xmlDoc) {
    return {
      stories: [],
      symbols: [],
      grid: new Map(),
      sections: [],
      data: {},
    };
  }

  // リスト形式のデータを先に抽出
  const listData = extractColumnSectionList(xmlDoc);

  // 全符号を収集
  const symbolSet = new Set();
  listData.sections.forEach((row) => {
    symbolSet.add(row.symbol);
  });

  // 符号を自然順でソート
  const symbols = Array.from(symbolSet);
  symbols.sort(compareSymbols);

  // 階を降順（上階から下階）にソート
  const sortedStories = [...listData.stories].sort(compareStoriesDescending);

  // グリッド構造を構築（Map<storyId, Map<symbol, sectionData>>）
  const grid = new Map();

  // セクションデータをグリッドに配置
  listData.sections.forEach((row) => {
    if (!grid.has(row.storyId)) {
      grid.set(row.storyId, new Map());
    }

    const floorMap = grid.get(row.storyId);
    const existing = floorMap.get(row.symbol);

    if (!existing) {
      floorMap.set(row.symbol, row.sectionData);
      return;
    }

    if (Array.isArray(existing)) {
      if (!existing.some((section) => section?.id === row.sectionData?.id)) {
        existing.push(row.sectionData);
        floorMap.set(row.symbol, existing);
        log.warn(
          '[extractColumnSectionGrid] Multiple sections detected in same cell:',
          `${row.storyId}:${row.symbol}`,
          existing.map((section) => section?.id),
        );
      }
      return;
    }

    if (existing.id !== row.sectionData.id) {
      const variants = [existing, row.sectionData];
      floorMap.set(row.symbol, variants);
      log.warn(
        '[extractColumnSectionGrid] Multiple sections detected in same cell:',
        `${row.storyId}:${row.symbol}`,
        variants.map((section) => section?.id),
      );
    }
  });

  // 断面が1つも無い階は表示対象から除外
  const storiesWithSections = sortedStories.filter((story) => {
    const floorMap = grid.get(story.id);
    return floorMap && floorMap.size > 0;
  });

  return {
    stories: storiesWithSections,
    symbols,
    grid,
    sections: listData.sections, // 互換性のため保持
    data: listData.data, // 互換性のため保持
  };
}

export default extractColumnSectionList;
