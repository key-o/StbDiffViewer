/**
 * @fileoverview ST-Bridge RC杭配筋を3D表示用の断面仕様へ変換する。
 *
 * 杭について日建連2023配筋標準図は「杭に関する事項は構造図による」こと、
 * および杭筋の重ね継手長さも構造図によることを明記している。
 * したがって、このモジュールでは杭固有の長さ・本数・径・ピッチを推定せず、
 * ST-Bridgeの StbSecBarArrangementPile_RC / StbSecBarPile_RC_* に
 * 明示された値だけを3D配置の正本として扱う。
 */

import { barDiameterMm, barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import { querySelector, querySelectorAll } from '../sectionListUtils.js';

const POSITION_ORDER = ['TOP', 'CENTER', 'BOTTOM'];

function numberAttr(element, name) {
  const raw = element?.getAttribute?.(name);
  if (raw == null || raw === '') return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function integerAttr(element, name) {
  const value = numberAttr(element, name);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function booleanAttr(element, name, fallback = false) {
  const raw = element?.getAttribute?.(name);
  if (raw == null || raw === '') return fallback;
  return String(raw).toLowerCase() === 'true';
}

function textAttr(element, name) {
  const raw = element?.getAttribute?.(name);
  return raw == null || raw === '' ? null : raw;
}

function extractPileGeometry(section) {
  const figure = querySelector(section, 'StbSecFigurePile_RC') || section;
  const straight = querySelector(figure, 'StbSecPile_RC_Straight');
  if (straight) {
    return {
      type: 'Straight',
      D: numberAttr(straight, 'D'),
    };
  }

  const extendedTopFoot = querySelector(figure, 'StbSecPile_RC_ExtendedTopFoot');
  if (extendedTopFoot) {
    return {
      type: 'ExtendedTopFoot',
      D_axial: numberAttr(extendedTopFoot, 'D_axial'),
      D_extended_top: numberAttr(extendedTopFoot, 'D_extended_top'),
      D_extended_foot: numberAttr(extendedTopFoot, 'D_extended_foot'),
      angle_extended_top_taper: numberAttr(extendedTopFoot, 'angle_extended_top_taper'),
      length_extended_foot: numberAttr(extendedTopFoot, 'length_extended_foot'),
      angle_extended_foot_taper: numberAttr(extendedTopFoot, 'angle_extended_foot_taper'),
    };
  }

  const extendedTop = querySelector(figure, 'StbSecPile_RC_ExtendedTop');
  if (extendedTop) {
    return {
      type: 'ExtendedTop',
      D_axial: numberAttr(extendedTop, 'D_axial'),
      D_extended_top: numberAttr(extendedTop, 'D_extended_top'),
      angle_extended_top_taper: numberAttr(extendedTop, 'angle_extended_top_taper'),
    };
  }

  const extendedFoot = querySelector(figure, 'StbSecPile_RC_ExtendedFoot');
  if (extendedFoot) {
    return {
      type: 'ExtendedFoot',
      D_axial: numberAttr(extendedFoot, 'D_axial'),
      D_extended_foot: numberAttr(extendedFoot, 'D_extended_foot'),
      length_extended_foot: numberAttr(extendedFoot, 'length_extended_foot'),
      angle_extended_foot_taper: numberAttr(extendedFoot, 'angle_extended_foot_taper'),
    };
  }

  return null;
}

function extractBar(element, diameterAttr, countAttr, strengthAttr) {
  const diaName = textAttr(element, diameterAttr);
  const count = integerAttr(element, countAttr);
  if (!diaName || !(count > 0)) return null;
  const diaMm = barDiameterMm(diaName, 0);
  if (!(diaMm > 0)) return null;
  return {
    diaName,
    diaMm,
    outerMm: barOuterDiameterMm(diaName, diaMm),
    count,
    grade: textAttr(element, strengthAttr),
  };
}

function extractBand(element) {
  const diaName = textAttr(element, 'D_band');
  const pitchMm = numberAttr(element, 'pitch_band');
  if (!diaName || !(pitchMm > 0)) return null;
  const diaMm = barDiameterMm(diaName, 0);
  if (!(diaMm > 0)) return null;
  return {
    diaName,
    diaMm,
    outerMm: barOuterDiameterMm(diaName, diaMm),
    pitchMm,
    grade: textAttr(element, 'strength_band'),
  };
}

function extractZone(element, fallbackPosition) {
  const position = (textAttr(element, 'pos') || fallbackPosition || '').toUpperCase();
  const main1 = extractBar(
    element,
    'D_main_circumference_1st',
    'N_main_circumference_1st',
    'strength_main_circumference_1st',
  );
  const main2 = extractBar(
    element,
    'D_main_circumference_2nd',
    'N_main_circumference_2nd',
    'strength_main_circumference_2nd',
  );
  const core = extractBar(element, 'D_main_core', 'N_main_core', 'strength_main_core');
  const band = extractBand(element);
  return {
    position,
    main1,
    main2,
    core,
    band,
    lengthBarMm: numberAttr(element, 'length_bar'),
    lapLengthMm: numberAttr(element, 'length_lap_bar'),
  };
}

function extractZones(arrangement) {
  const same = querySelector(arrangement, 'StbSecBarPile_RC_Same');
  if (same) return { mode: 'SAME', zones: [extractZone(same, 'ALL')] };

  const topCenterBottom = querySelectorAll(arrangement, 'StbSecBarPile_RC_TopCenterBottom');
  if (topCenterBottom.length) {
    return {
      mode: 'TOP_CENTER_BOTTOM',
      zones: topCenterBottom
        .map((element) => extractZone(element))
        .sort((a, b) => POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position)),
    };
  }

  const topBottom = querySelectorAll(arrangement, 'StbSecBarPile_RC_TopBottom');
  if (topBottom.length) {
    return {
      mode: 'TOP_BOTTOM',
      zones: topBottom
        .map((element) => extractZone(element))
        .sort((a, b) => POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position)),
    };
  }

  return { mode: null, zones: [] };
}

function resolvePileApplyCondition(xmlDoc) {
  const applyList = querySelector(xmlDoc, 'StbApplyConditionsList');
  if (!applyList) {
    return {
      applyListPresent: false,
      applicable: true,
      defaultCoverMm: null,
    };
  }

  const pileApply = querySelector(applyList, 'StbPile_RC_BarPositionApply');
  if (!pileApply) {
    return {
      applyListPresent: true,
      applicable: false,
      defaultCoverMm: null,
    };
  }

  const setDefault = booleanAttr(pileApply, 'set_default', false);
  return {
    applyListPresent: true,
    applicable: true,
    defaultCoverMm: setDefault ? numberAttr(pileApply, 'depth_cover') : null,
  };
}

function validGeometry(geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Straight') return geometry.D > 0;
  if (!(geometry.D_axial > 0)) return false;
  if (geometry.type === 'ExtendedTop') return geometry.D_extended_top > 0;
  if (geometry.type === 'ExtendedFoot') return geometry.D_extended_foot > 0;
  if (geometry.type === 'ExtendedTopFoot') {
    return geometry.D_extended_top > 0 && geometry.D_extended_foot > 0;
  }
  return false;
}

function validateZones(mode, zones) {
  if (!mode || !zones?.length) return false;
  if (mode === 'SAME') return zones.length === 1;
  if (mode === 'TOP_BOTTOM') {
    return zones.length === 2 && zones[0]?.position === 'TOP' && zones[1]?.position === 'BOTTOM';
  }
  if (mode === 'TOP_CENTER_BOTTOM') {
    return (
      zones.length === 3 &&
      zones[0]?.position === 'TOP' &&
      zones[1]?.position === 'CENTER' &&
      zones[2]?.position === 'BOTTOM'
    );
  }
  return false;
}

/**
 * RC杭断面ごとの3D配筋仕様を抽出する。
 *
 * @param {Document} xmlDoc ST-Bridge XML DOM
 * @param {Object} [options] `coverMm` は表示上の明示オーバーライド
 * @returns {Map<string, Object>} section id -> pile reinforcement specification
 */
export function buildPileRebarSectionMap(xmlDoc, options = {}) {
  const result = new Map();
  if (!xmlDoc) return result;

  const apply = resolvePileApplyCondition(xmlDoc);
  const coverOverride = Number(options.coverMm);
  const hasCoverOverride = Number.isFinite(coverOverride) && coverOverride >= 0;

  for (const section of querySelectorAll(xmlDoc, 'StbSecPile_RC')) {
    const id = textAttr(section, 'id');
    if (!id) continue;

    const geometry = extractPileGeometry(section);
    const arrangement = querySelector(section, 'StbSecBarArrangementPile_RC');
    if (!validGeometry(geometry) || !arrangement) continue;

    const { mode, zones } = extractZones(arrangement);
    if (!validateZones(mode, zones)) continue;
    if (!zones.every((zone) => zone.main1 && zone.band)) continue;

    // StbApplyConditionsList が明示され、杭筋位置適用要素が無い場合は仕様通り位置を無効とする。
    if (!hasCoverOverride && !apply.applicable) continue;

    const explicitCover = numberAttr(arrangement, 'depth_cover');
    const explicitTopCover = numberAttr(arrangement, 'depth_cover_top');
    const coverMm = hasCoverOverride ? coverOverride : (explicitCover ?? apply.defaultCoverMm);
    const coverTopMm = hasCoverOverride
      ? coverOverride
      : (explicitTopCover ?? explicitCover ?? apply.defaultCoverMm);
    if (!(Number.isFinite(coverMm) && coverMm >= 0)) continue;

    const unresolved = [];
    for (const zone of zones) {
      if (zone.main2) {
        unresolved.push({
          code: 'PILE_SECOND_LAYER_RADIAL_POSITION_UNDEFINED',
          position: zone.position,
          message:
            'StbSecBarPile_RC_* は2段目の径・本数を持つが、杭の2段筋半径/段間隔を規定しないため3D位置を一意に決定できない。',
        });
      }
      if (zone.core) {
        unresolved.push({
          code: 'PILE_CORE_BAR_POSITION_UNDEFINED',
          position: zone.position,
          message: 'ST-Bridge仕様上、杭の芯筋は位置情報を持たないため3D位置を一意に決定できない。',
        });
      }
    }

    result.set(String(id), {
      kind: 'pileRebar',
      sectionId: String(id),
      sectionName: textAttr(section, 'name'),
      geometry,
      mode,
      zones,
      coverMm,
      coverTopMm: Number.isFinite(coverTopMm) ? coverTopMm : coverMm,
      coverSource: hasCoverOverride
        ? 'viewer-override'
        : explicitCover != null
          ? 'stb-explicit'
          : 'stb-apply-default',
      isSpiral: booleanAttr(arrangement, 'isSpiral', false),
      unresolved,
      sourceRule: 'ST-Bridge 2.0.2 / Nikkenren-JSCA 2023 pile-detail-by-drawing',
    });
  }

  return result;
}

/**
 * 3D配置可能な第1周主筋の有無を判定する。
 */
export function hasRenderablePileMain(spec) {
  return Boolean(spec?.zones?.some((zone) => zone.main1?.count > 0));
}

/**
 * 3D配置可能な帯筋/スパイラルの有無を判定する。
 */
export function hasRenderablePileBand(spec) {
  return Boolean(spec?.zones?.some((zone) => zone.band?.pitchMm > 0));
}
