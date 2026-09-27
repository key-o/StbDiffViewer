/**
 * @fileoverview RC梁の腹筋・幅止筋のSTB適用条件と配置fact解決。
 *
 * ST-Bridge 2.0.2では、断面要素の明示属性を最優先し、
 * StbApplyConditionsList の set_default=true は欠損属性だけを補う。
 * Apply子要素自体が無い場合は「適用対象外」とする仕様をここで一元化する。
 * そのうえで STB に情報が無い場合のみ project common config を参照する。
 *
 * 仕様書の属性表は D_web / N_web を正本とする一方、同仕様書のApplyConditions例では
 * D_bar_web / N_bar_web という旧名が記載されているため、読取り側は両方を受理する。
 */

import { getRebarCommonConfig } from '../../../config/rebarCommonConfig.js';
import { querySelector } from '../sectionListUtils.js';

const AUXILIARY_FACTS = Symbol.for('stbviewer.beamAuxiliaryFacts');

function attributeNames(value) {
  return Array.isArray(value) ? value : [value];
}

function firstPresentAttribute(element, value) {
  return attributeNames(value).find((name) => Boolean(element?.hasAttribute?.(name))) || null;
}

function readString(element, value) {
  const name = firstPresentAttribute(element, value);
  return name ? element.getAttribute(name)?.toUpperCase() || null : null;
}

function readNumber(element, value) {
  const name = firstPresentAttribute(element, value);
  if (!name) return null;
  const parsed = Number(element.getAttribute(name));
  return Number.isFinite(parsed) ? parsed : null;
}

function rawFact(element, definitions) {
  const fields = {};
  const present = {};
  for (const [key, attributes] of Object.entries(definitions)) {
    present[key] = firstPresentAttribute(element, attributes) !== null;
    fields[key] =
      key === 'dia' || key === 'grade'
        ? readString(element, attributes)
        : readNumber(element, attributes);
  }
  return {
    ...fields,
    present,
    hasAny: Object.values(present).some(Boolean),
    source: 'stb-direct',
  };
}

/**
 * v2.0.2の直接属性を、既存2D APIを汚さない非enumerable factとして保持する。
 */
export function captureLegacyBeamAuxiliaryFacts(barElement, positionData) {
  if (!barElement || !positionData) return;
  const value = {
    webBar: rawFact(barElement, {
      dia: ['D_web', 'D_bar_web'],
      count: ['N_web', 'N_bar_web'],
      grade: 'strength_web',
    }),
    widthTie: rawFact(barElement, {
      dia: 'D_bar_spacing',
      count: 'N_bar_spacing',
      pitch: 'pitch_bar_spacing',
      grade: 'strength_bar_spacing',
    }),
  };
  Object.defineProperty(positionData, AUXILIARY_FACTS, {
    value,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

function getCaptured(positionData, key) {
  return positionData?.[AUXILIARY_FACTS]?.[key] || null;
}

function rootVersion(xmlDoc) {
  const root = xmlDoc?.documentElement;
  return root?.getAttribute?.('version') || '';
}

function parseApply(xmlDoc, tagName, definitions) {
  const element = querySelector(xmlDoc, tagName);
  if (!element) {
    return {
      applicable: false,
      setDefault: false,
      defaults: {},
      source: 'stb-not-applicable',
    };
  }

  const setDefault = element.getAttribute('set_default') === 'true';
  const defaults = {};
  for (const [key, attributes] of Object.entries(definitions)) {
    if (!firstPresentAttribute(element, attributes)) continue;
    defaults[key] =
      key === 'dia' || key === 'grade'
        ? readString(element, attributes)
        : readNumber(element, attributes);
  }
  return { applicable: true, setDefault, defaults, source: 'stb-apply' };
}

/**
 * v2.0.xだけApplyConditionsを仕様どおりgateする。2.1.xは変換後構造が異なるためnullを返す。
 */
export function resolveBeamAuxiliaryApplyPolicy(xmlDoc) {
  if (!xmlDoc || !rootVersion(xmlDoc).startsWith('2.0')) return null;
  return {
    webBar: parseApply(xmlDoc, 'StbBeam_RC_BarWebApply', {
      dia: ['D_web', 'D_bar_web'],
      count: ['N_web', 'N_bar_web'],
    }),
    widthTie: parseApply(xmlDoc, 'StbBeam_RC_BarSpacingApply', {
      dia: 'D_bar_spacing',
      count: 'N_bar_spacing',
      pitch: 'pitch_bar_spacing',
    }),
  };
}

function legacyWebFallback(positionData) {
  const web = positionData?.webBar;
  if (!web) return null;
  return {
    dia: web.dia || null,
    count: Number.isFinite(Number(web.count)) ? Number(web.count) : null,
    grade: web.grade || null,
    present: {
      dia: Boolean(web.dia),
      count: web.count !== null && web.count !== undefined,
      grade: Boolean(web.grade),
    },
    hasAny: true,
    source: 'stb-section',
  };
}

function ruleFact(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const dia = String(rule.dia || rule.D || '').toUpperCase() || null;
  const countRaw = rule.count ?? rule.N;
  const pitchRaw = rule.pitch ?? rule.pitchMm;
  return {
    dia,
    count: Number.isFinite(Number(countRaw)) ? Number(countRaw) : null,
    pitch: Number.isFinite(Number(pitchRaw)) ? Number(pitchRaw) : null,
    grade: rule.grade || rule.strength || null,
  };
}

function applyDefaults(raw, apply, keys) {
  if (!raw) return null;
  const merged = { ...raw };
  if (!apply?.setDefault) return merged;
  for (const key of keys) {
    if (raw.present?.[key]) continue;
    if (apply.defaults?.[key] !== undefined) merged[key] = apply.defaults[key];
  }
  return merged;
}

function emptyRawFact(fields) {
  return {
    present: Object.fromEntries(fields.map((key) => [key, false])),
    hasAny: false,
    source: 'stb-direct',
  };
}

/**
 * STB候補を作る。
 *
 * 断面側に属性が1つも無い場合でも、ApplyConditions の set_default=true かつ
 * 必要属性の省略値が存在すれば、その省略値だけで候補を構成する。
 * これにより「直接属性なし + Apply既定値」の正規経路を project config へ落とさない。
 */
function buildStbCandidate(raw, apply, fields) {
  if (raw?.hasAny) return applyDefaults(raw, apply, fields);

  const hasApplyDefault =
    apply?.setDefault && fields.some((key) => apply.defaults?.[key] !== undefined);
  if (!hasApplyDefault) return null;

  return applyDefaults(raw || emptyRawFact(fields), apply, fields);
}

function resolvedNone(source, reason = null) {
  return { status: 'none', value: null, source, unresolved: reason ? [reason] : [] };
}

function unresolved(source, reason) {
  return { status: 'unresolved', value: null, source, unresolved: [reason] };
}

function resolveFact({ raw, apply, configRule, fields, kind }) {
  if (apply && !apply.applicable) return resolvedNone('stb-not-applicable');

  const candidate = buildStbCandidate(raw, apply, fields);
  if (candidate) {
    if (candidate.present?.count && Number(candidate.count) <= 0) {
      return resolvedNone(candidate.source);
    }
    const missing = fields.filter((key) => {
      if (key === 'count') return !(Number(candidate.count) > 0);
      if (key === 'pitch') return !(Number(candidate.pitch) > 0);
      return !candidate[key];
    });
    if (missing.length === 0) {
      return {
        status: 'resolved',
        value: {
          dia: candidate.dia,
          count: Number(candidate.count),
          ...(fields.includes('pitch') ? { pitch: Number(candidate.pitch) } : {}),
          grade: candidate.grade || null,
        },
        source:
          apply?.setDefault &&
          fields.some((key) => !candidate.present?.[key] && apply.defaults?.[key] !== undefined)
            ? 'stb-apply-default'
            : candidate.source,
        unresolved: [],
      };
    }
    return unresolved(candidate.source, `${kind}-incomplete-stb:${missing.join(',')}`);
  }

  const configured = ruleFact(configRule);
  if (configured) {
    if (Number(configured.count) <= 0 && configured.count !== null) {
      return resolvedNone('project-config');
    }
    const missing = fields.filter((key) => {
      if (key === 'count') return !(Number(configured.count) > 0);
      if (key === 'pitch') return !(Number(configured.pitch) > 0);
      return !configured[key];
    });
    if (missing.length === 0) {
      return {
        status: 'resolved',
        value: configured,
        source: 'project-config',
        unresolved: [],
      };
    }
  }

  // 日建連標準には配置要否の目安はあるが、D/Nを一意に決める完全な既定値はないため捏造しない。
  return unresolved('standard-unresolved', `${kind}-no-complete-default`);
}

export function resolveBeamWebBar(
  positionData,
  applyPolicy = null,
  config = getRebarCommonConfig(),
) {
  const raw = getCaptured(positionData, 'webBar') || legacyWebFallback(positionData);
  return resolveFact({
    raw,
    apply: applyPolicy?.webBar,
    configRule: config?.girder?.webBarRule,
    fields: ['dia', 'count'],
    kind: 'web-bar',
  });
}

export function resolveBeamWidthTie(
  positionData,
  applyPolicy = null,
  config = getRebarCommonConfig(),
) {
  const raw = getCaptured(positionData, 'widthTie');
  return resolveFact({
    raw,
    apply: applyPolicy?.widthTie,
    configRule: config?.girder?.widthTieRule,
    fields: ['dia', 'count', 'pitch'],
    kind: 'width-tie',
  });
}
