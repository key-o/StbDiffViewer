/**
 * @fileoverview RC梁配筋の意味等価比較用正規化
 *
 * ST-Bridge 2.0.2 / 2.1.x の Same / ThreeTypes / StartEnd / Simple / Complex の
 * 記述差を既存のRC梁断面抽出器で吸収し、概略属性比較で使う正規形へ変換する。
 */

import { extractRcBeamSectionDetail } from '../../data/extractors/beamSectionList/sectionDetail.js';
import { getCommonReinforcementStrengthMap } from '../../data/extractors/reinforcementStrengthResolver.js';
import { orderedPositionKeys } from '../../data/extractors/rebar3d/rebarSectionUtils.js';
import { normalizeMaterialGradeForEquivalence } from './materialGradeEquivalence.js';

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

function resolvedGrade(grade, dia, commonStrengths) {
  const explicit = normalizeText(grade);
  if (explicit) return explicit;
  const diameter = normalizeText(dia);
  return diameter ? normalizeText(commonStrengths.get(diameter)) : null;
}

function mergeGroups(groups) {
  const merged = new Map();
  for (const group of groups) {
    const count = Number(group?.count) || 0;
    if (count <= 0) continue;
    const dia = normalizeText(group?.dia);
    const grade = normalizeText(group?.grade);
    const sourceGrade = normalizeText(group?.sourceGrade);
    const key = `${dia || ''}|${grade || ''}`;
    const current = merged.get(key);
    if (current) {
      current.count += count;
      if (sourceGrade && !current.sourceGrades.includes(sourceGrade)) {
        current.sourceGrades.push(sourceGrade);
        current.sourceGrades.sort();
      }
    } else {
      merged.set(key, {
        count,
        dia,
        grade,
        sourceGrades: sourceGrade ? [sourceGrade] : [],
      });
    }
  }
  return Array.from(merged.values()).sort(
    (a, b) =>
      String(a.dia || '').localeCompare(String(b.dia || '')) ||
      String(a.grade || '').localeCompare(String(b.grade || '')) ||
      a.count - b.count,
  );
}

function normalizeMainBar(bar, commonStrengths) {
  if (!bar) return null;

  const rawLayers =
    Array.isArray(bar.layers) && bar.layers.length > 0
      ? bar.layers
      : [
          {
            step: 1,
            count: Number(bar.count1st ?? bar.count) || 0,
            dia: bar.dia,
            grade: bar.grade,
          },
          { step: 2, count: Number(bar.count2nd) || 0, dia: bar.dia, grade: bar.grade },
          { step: 3, count: Number(bar.count3rd) || 0, dia: bar.dia, grade: bar.grade },
        ];

  const byStep = new Map();
  rawLayers.forEach((layer, index) => {
    const step = Number(layer?.step) > 0 ? Number(layer.step) : index + 1;
    const sourceGroups =
      Array.isArray(layer?.barGroups) && layer.barGroups.length > 0
        ? layer.barGroups
        : [{ count: layer?.count, dia: layer?.dia || bar.dia, grade: layer?.grade || bar.grade }];

    const normalizedGroups = sourceGroups
      .map((group) => {
        const dia = normalizeText(group?.dia || layer?.dia || bar.dia);
        const sourceGrade = resolvedGrade(
          group?.grade || layer?.grade || bar.grade,
          dia,
          commonStrengths,
        );
        return {
          count: Number(group?.count) || 0,
          dia,
          grade: normalizeMaterialGradeForEquivalence(sourceGrade),
          sourceGrade,
        };
      })
      .filter((group) => group.count > 0);

    if (normalizedGroups.length === 0) return;
    const existing = byStep.get(step) || [];
    existing.push(...normalizedGroups);
    byStep.set(step, existing);
  });

  const layers = Array.from(byStep.entries())
    .map(([step, groups]) => ({ step, groups: mergeGroups(groups) }))
    .filter((layer) => layer.groups.length > 0)
    .sort((a, b) => a.step - b.step);

  return layers.length > 0 ? layers : null;
}

function normalizeStirrup(stirrup, commonStrengths) {
  if (!stirrup) return null;
  const count = Number(stirrup.count) || 0;
  const pitch = Number(stirrup.pitch) || 0;
  const dia = normalizeText(stirrup.dia);
  if (count <= 0 || !dia) return null;
  const sourceGrade = resolvedGrade(stirrup.grade, dia, commonStrengths);
  return {
    count,
    dia,
    grade: normalizeMaterialGradeForEquivalence(sourceGrade),
    sourceGrade,
    pitch: pitch > 0 ? pitch : null,
  };
}

function normalizeWebBar(webBar, commonStrengths) {
  if (!webBar) return null;
  const count = Number(webBar.count) || 0;
  const dia = normalizeText(webBar.dia);
  if (count <= 0 || !dia) return null;
  const sourceGrade = resolvedGrade(webBar.grade, dia, commonStrengths);
  return {
    count,
    dia,
    grade: normalizeMaterialGradeForEquivalence(sourceGrade),
    sourceGrade,
  };
}

function normalizePosition(positionData, commonStrengths) {
  return {
    top: normalizeMainBar(positionData?.topBar, commonStrengths),
    bottom: normalizeMainBar(positionData?.bottomBar, commonStrengths),
    stirrup: normalizeStirrup(positionData?.stirrup, commonStrengths),
    web: normalizeWebBar(positionData?.webBar, commonStrengths),
  };
}

function hasPositionData(spec) {
  return Boolean(spec?.top || spec?.bottom || spec?.stirrup || spec?.web);
}

function comparableGroups(groups) {
  return groups?.map((group) => ({
    count: group.count,
    dia: group.dia,
    grade: group.grade,
  }));
}

function comparableMainBar(layers) {
  return layers?.map((layer) => ({
    step: layer.step,
    groups: comparableGroups(layer.groups),
  }));
}

function comparablePosition(spec) {
  return {
    top: comparableMainBar(spec?.top) || null,
    bottom: comparableMainBar(spec?.bottom) || null,
    stirrup: spec?.stirrup
      ? {
          count: spec.stirrup.count,
          dia: spec.stirrup.dia,
          grade: spec.stirrup.grade,
          pitch: spec.stirrup.pitch,
        }
      : null,
    web: spec?.web
      ? {
          count: spec.web.count,
          dia: spec.web.dia,
          grade: spec.web.grade,
        }
      : null,
  };
}

function sameSpec(a, b) {
  return JSON.stringify(comparablePosition(a)) === JSON.stringify(comparablePosition(b));
}

function mapRawPositions(raw) {
  const positions = {};
  if (raw.LEFT) positions.START = raw.LEFT;
  if (raw.CENTER) positions.CENTER = raw.CENTER;
  if (raw.RIGHT) positions.END = raw.RIGHT;
  for (const [key, spec] of Object.entries(raw)) {
    if (key === 'LEFT' || key === 'CENTER' || key === 'RIGHT') continue;
    positions[key] = spec;
  }
  return positions;
}

function canonicalizePositions(detail, commonStrengths) {
  const raw = {};
  const positionKeys = orderedPositionKeys(detail);
  for (const key of positionKeys) {
    const spec = normalizePosition(detail?.positions?.[key], commonStrengths);
    if (hasPositionData(spec)) raw[key] = spec;
  }

  const keys = Object.keys(raw);
  const sourcePositions = mapRawPositions(raw);
  if (keys.length === 0) {
    return { pattern: 'NONE', positions: {}, sourcePositions };
  }

  // 配筋の無い位置が混ざる断面（例: 中央のみ配筋）は、全位置が同一仕様の断面と等価にならない。
  // 位置の畳み込み（SAME / END_CENTER / START_END）は全位置に配筋がある場合に限る。
  const hasEmptyPosition = keys.length !== positionKeys.length;

  const first = raw[keys[0]];
  if (!hasEmptyPosition && keys.every((key) => sameSpec(first, raw[key]))) {
    return { pattern: 'SAME', positions: { SAME: first }, sourcePositions };
  }

  if (!hasEmptyPosition && raw.LEFT && raw.CENTER && raw.RIGHT && sameSpec(raw.LEFT, raw.RIGHT)) {
    return {
      pattern: 'END_CENTER',
      positions: { END: raw.LEFT, CENTER: raw.CENTER },
      sourcePositions,
    };
  }

  if (!hasEmptyPosition && raw.LEFT && raw.CENTER && !raw.RIGHT && keys.length === 2) {
    return {
      pattern: 'END_CENTER',
      positions: { END: raw.LEFT, CENTER: raw.CENTER },
      sourcePositions,
    };
  }

  if (!hasEmptyPosition && raw.LEFT && raw.RIGHT && !raw.CENTER && keys.length === 2) {
    return {
      pattern: 'START_END',
      positions: { START: raw.LEFT, END: raw.RIGHT },
      sourcePositions,
    };
  }

  return { pattern: 'THREE_OR_COMPLEX', positions: sourcePositions, sourcePositions };
}

function describeGroups(groups) {
  return groups
    .map((group) => {
      const grade = group.sourceGrades?.length ? group.sourceGrades.join('/') : group.grade;
      return `${group.count}-${group.dia || '?'}${grade ? ` ${grade}` : ''}`;
    })
    .join('+');
}

function describeMainBar(layers) {
  if (!layers?.length) return 'なし';
  return layers.map((layer) => `${layer.step}段 ${describeGroups(layer.groups)}`).join(', ');
}

function describePosition(spec) {
  const items = [`上端: ${describeMainBar(spec?.top)}`, `下端: ${describeMainBar(spec?.bottom)}`];
  if (spec?.stirrup) {
    const grade = spec.stirrup.sourceGrade || spec.stirrup.grade;
    items.push(
      `あばら筋: ${spec.stirrup.count}-${spec.stirrup.dia}${
        grade ? ` ${grade}` : ''
      }${spec.stirrup.pitch ? ` @${spec.stirrup.pitch}` : ''}`,
    );
  } else {
    items.push('あばら筋: なし');
  }
  if (spec?.web) {
    const grade = spec.web.sourceGrade || spec.web.grade;
    items.push(`腹筋: ${spec.web.count}-${spec.web.dia}${grade ? ` ${grade}` : ''}`);
  } else {
    items.push('腹筋: なし');
  }
  return items.join('\n');
}

/**
 * RC梁断面を配筋比較用の正規形へ変換する。
 * かぶり・主筋重心位置は「配筋量/鉄筋仕様」ではなく配置位置情報として本比較から除外する。
 *
 * 比較キーでは材料グレードを正規化する一方、表示用 descriptions には
 * 各モデルの元表記（個別指定または StbCommon から解決した値）を保持する。
 *
 * @param {Element|null} sectionElement
 * @returns {Object|null}
 */
export function buildBeamReinforcementEquivalenceData(sectionElement) {
  const tagName = sectionElement?.tagName || sectionElement?.localName || '';
  if (!['StbSecBeam_RC', 'StbSecGirder_RC'].includes(tagName)) return null;

  const detail = extractRcBeamSectionDetail(sectionElement);
  const commonStrengths = getCommonReinforcementStrengthMap(sectionElement);
  const canonical = canonicalizePositions(detail, commonStrengths);
  const descriptions = Object.fromEntries(
    Object.entries(canonical.positions).map(([key, spec]) => [key, describePosition(spec)]),
  );
  const positions = Object.fromEntries(
    Object.entries(canonical.positions).map(([key, spec]) => [key, comparablePosition(spec)]),
  );
  const sourceDescriptions = Object.fromEntries(
    Object.entries(canonical.sourcePositions).map(([key, spec]) => [key, describePosition(spec)]),
  );
  const sourcePositions = Object.fromEntries(
    Object.entries(canonical.sourcePositions).map(([key, spec]) => [key, comparablePosition(spec)]),
  );

  return {
    kind: 'RC_BEAM',
    pattern: canonical.pattern,
    positions,
    descriptions,
    sourcePositions,
    sourceDescriptions,
    signature: JSON.stringify({ pattern: canonical.pattern, positions }),
    hasData: Object.keys(positions).length > 0,
  };
}
