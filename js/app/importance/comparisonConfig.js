/**
 * @fileoverview 要素重要度評価・エクスポート/インポート
 *
 * ImportanceManagerの要素重要度評価ロジックとJSON形式の
 * エクスポート/インポート機能を分離したモジュール。
 *
 * @module app/importance/comparisonConfig
 */

import { IMPORTANCE_LEVELS } from '../../constants/importanceLevels.js';
import { MVD_MODES } from '../../constants/importanceConstants.js';
import {
  getElementDefinition,
  validateAttributeValue,
} from '../../common-stb/import/parser/xsdSchemaParser.js';
import { createLogger } from '../../utils/logger.js';
import { setMvdImportanceLevel, rebuildEffectiveImportanceSettings } from './mvdModeManager.js';
import { notifySettingsChanged } from './settingsManager.js';
import { readElementAttribute } from '../../data/accessors/elementAttributeAccessor.js';

const log = createLogger('app:importance:comparison');

/**
 * 要素の重要度を取得する
 * @param {ImportanceManager} manager
 * @param {Object} element - 要素データ
 * @param {string} elementType - 要素タイプ（オプション）
 * @returns {string} 重要度レベル
 */
export function getElementImportance(manager, element, elementType = null) {
  if (!manager.isInitialized) {
    return IMPORTANCE_LEVELS.REQUIRED; // デフォルト
  }

  // 要素タイプの決定
  let type = elementType;
  if (!type && element) {
    // element から要素タイプを推測
    if (typeof element.getAttribute === 'function') {
      // DOM Element の場合（あまり使われないが念のため）
      type = element.tagName;
    } else if (typeof element === 'object') {
      // JavaScript object の場合
      // elementType プロパティがあればそれを使用
      type = element.elementType || element.type;
    }
  }

  if (!type) {
    return IMPORTANCE_LEVELS.REQUIRED; // デフォルト
  }

  if (type === 'ShearWall' || type === 'StbShearWall') {
    type = 'Wall';
  }

  const resolvedType = type.startsWith('Stb') ? type : `Stb${type}`;

  const elementDef = getElementDefinition(resolvedType);
  const schemaAttributes = new Set(
    elementDef?.attributes ? Array.from(elementDef.attributes.keys()) : [],
  );

  // この要素タイプに対して設定されている属性重要度パスを対象に、
  // 必須チェック + 値制約チェック（JSONスキーマ）を行う。
  const pathMarker = `/${resolvedType}/@`;
  let hasTargetViolation = false;

  for (const [path, configuredLevel] of manager.userImportanceSettings.entries()) {
    if (!path || !path.includes(pathMarker)) continue;
    if (configuredLevel !== IMPORTANCE_LEVELS.REQUIRED) continue;

    const markerIndex = path.lastIndexOf('/@');
    if (markerIndex < 0) continue;
    const attrName = path.slice(markerIndex + 2);
    if (!attrName) continue;
    if (schemaAttributes.size > 0 && !schemaAttributes.has(attrName)) continue;

    const checkOptions = manager.s2ParameterChecks.get(path) || {
      checkRequired: true,
      checkValue: true,
    };
    if (!checkOptions.checkRequired && !checkOptions.checkValue) {
      continue;
    }

    const value = readElementAttribute(element, attrName, {
      missingValue: undefined,
      coerceToString: false,
    });
    const isMissing = value === undefined || value === null || value === '';
    if (isMissing && checkOptions.checkRequired) {
      hasTargetViolation = true;
      continue;
    }

    if (!isMissing && checkOptions.checkValue) {
      const validation = validateAttributeValue(resolvedType, attrName, String(value));
      if (!validation.valid) {
        hasTargetViolation = true;
      }
    }
  }

  if (hasTargetViolation) {
    return IMPORTANCE_LEVELS.REQUIRED;
  }

  return IMPORTANCE_LEVELS.NOT_APPLICABLE;
}

/**
 * 重要度設定をJSON形式（mvd-s2.json互換フォーマット）でエクスポートする
 * @param {ImportanceManager} manager
 * @param {string} mvdLevel - 's2' | 's4' | 'combined'
 * @returns {string} JSON形式の文字列
 */
export function exportToJSON(manager, mvdLevel = 'combined') {
  const elements = {};

  if (mvdLevel === 'combined' || mvdLevel === 's2') {
    for (const [path, level] of manager.mvdImportanceSettings[MVD_MODES.S2].entries()) {
      if (level !== IMPORTANCE_LEVELS.REQUIRED) continue;
      // path例: //ST_BRIDGE/StbColumn/@id → elementName: StbColumn, attr: id
      const match = path.match(/\/\/ST_BRIDGE\/([^/]+)\/@(.+)/);
      if (!match) continue;
      const [, elementName, attr] = match;
      if (!elements[elementName]) elements[elementName] = { required: [] };
      if (!elements[elementName].required.includes(attr)) {
        elements[elementName].required.push(attr);
      }
    }
  }

  const result = {
    version: '1.0',
    mvdLevel: mvdLevel === 'combined' ? 'combined' : mvdLevel,
    schemaVersion: '2.0.2',
    description: `MVD ${mvdLevel.toUpperCase()} - エクスポート設定`,
    elements,
  };
  return JSON.stringify(result, null, 2);
}

/**
 * JSON形式の重要度設定をインポートする（mvd-s2.json互換フォーマット）
 * @param {ImportanceManager} manager
 * @param {string} jsonContent - JSON文字列
 * @returns {boolean} インポート成功フラグ
 */
export function importFromJSON(manager, jsonContent) {
  try {
    const config = JSON.parse(jsonContent);
    if (!config.elements || typeof config.elements !== 'object') {
      return false;
    }

    const targetMvd = config.mvdLevel === 's4' ? [MVD_MODES.S4] : [MVD_MODES.S2, MVD_MODES.S4];

    for (const [elementName, elementDef] of Object.entries(config.elements)) {
      for (const attr of elementDef.required || []) {
        const path = `//ST_BRIDGE/${elementName}/@${attr}`;
        for (const mode of targetMvd) {
          setMvdImportanceLevel(manager, path, mode, IMPORTANCE_LEVELS.REQUIRED, {
            notify: false,
            rebuild: false,
          });
        }
      }
    }

    rebuildEffectiveImportanceSettings(manager);
    notifySettingsChanged(manager);
    return true;
  } catch (error) {
    log.error('JSONのインポートに失敗しました:', error);
    return false;
  }
}
