/**
 * @fileoverview 重要度に基づく表示機能
 *
 * 属性の重要度レベルに基づいてインジケータを生成する機能を提供します。
 * 重要度は属性名セルの丸インジケータ（●）で表現し、
 * セル背景色は比較結果（differs）専用とします。
 */

import { IMPORTANCE_LEVELS } from '../../../constants/importanceLevels.js';
import { getImportanceManager } from '../../../app/importanceManager.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('ui:panels:element-info:ImportanceColors');

// 構造部材のマッピング (StbMembers配下)
const MEMBER_MAPPING = {
  Column: 'StbModel/StbMembers/StbColumns/StbColumn',
  Post: 'StbModel/StbMembers/StbPosts/StbPost',
  Girder: 'StbModel/StbMembers/StbGirders/StbGirder',
  Beam: 'StbModel/StbMembers/StbBeams/StbBeam',
  Brace: 'StbModel/StbMembers/StbBraces/StbBrace',
  Slab: 'StbModel/StbMembers/StbSlabs/StbSlab',
  Wall: 'StbModel/StbMembers/StbWalls/StbWall',
  Footing: 'StbModel/StbMembers/StbFootings/StbFooting',
  StripFooting: 'StbModel/StbMembers/StbStripFootings/StbStripFooting',
  Pile: 'StbModel/StbMembers/StbPiles/StbPile',
  FoundationColumn: 'StbModel/StbMembers/StbFoundationColumns/StbFoundationColumn',
  Parapet: 'StbModel/StbMembers/StbParapets/StbParapet',
  Open: 'StbModel/StbMembers/StbOpens/StbOpen',
  IsolatingDevice: 'StbModel/StbMembers/StbIsolatingDevices/StbIsolatingDevice',
  DampingDevice: 'StbModel/StbMembers/StbDampingDevices/StbDampingDevice',
  FrameDampingDevice: 'StbModel/StbMembers/StbFrameDampingDevices/StbFrameDampingDevice',
};

// その他の要素マッピング
const OTHER_MAPPING = {
  Node: 'StbModel/StbNodes/StbNode',
  Story: 'StbModel/StbStories/StbStory',
};

/**
 * 要素タイプと属性名からXPathスタイルの属性パスを構築する
 * @param {string} elementType - 要素タイプ
 * @param {string} attributeName - 属性名
 * @returns {string|null} 属性パス（構築できない場合はnull）
 */
function buildAttributePath(elementType, attributeName) {
  if (!elementType || !attributeName) return null;

  // 構造部材
  if (MEMBER_MAPPING[elementType]) {
    return `//ST_BRIDGE/${MEMBER_MAPPING[elementType]}/@${attributeName}`;
  }
  // その他の要素
  if (OTHER_MAPPING[elementType]) {
    return `//ST_BRIDGE/${OTHER_MAPPING[elementType]}/@${attributeName}`;
  }
  // 断面要素
  if (elementType.startsWith('Sec') || elementType.startsWith('StbSec')) {
    const stbElementName = elementType.startsWith('Stb') ? elementType : `Stb${elementType}`;
    return `//ST_BRIDGE/StbModel/StbSections/${stbElementName}/@${attributeName}`;
  }
  // 接合部要素
  if (elementType.startsWith('Joint') || elementType.startsWith('StbJoint')) {
    const stbElementName = elementType.startsWith('Stb') ? elementType : `Stb${elementType}`;
    return `//ST_BRIDGE/StbModel/StbJoints/${stbElementName}/@${attributeName}`;
  }
  // その他（フォールバック）
  const stbElementName = elementType.startsWith('Stb') ? elementType : `Stb${elementType}`;
  return `//ST_BRIDGE/StbModel/${stbElementName}/@${attributeName}`;
}

/**
 * 属性の実効重要度（統合）を取得する
 * @param {string} elementType - 要素タイプ (例: 'Column', 'Node', 'SecColumn_RC')
 * @param {string} attributeName - 属性名 (例: 'id', 'name')
 * @returns {string} 重要度レベル ('required', 'optional', 'unnecessary', 'notApplicable')
 */
export function getAttributeImportanceLevel(elementType, attributeName) {
  try {
    const attributePath = buildAttributePath(elementType, attributeName);
    if (!attributePath) return IMPORTANCE_LEVELS.OPTIONAL;

    const manager = getImportanceManager();
    if (manager?.isInitialized) {
      return manager.getImportanceLevel(attributePath);
    }
    return IMPORTANCE_LEVELS.OPTIONAL;
  } catch (error) {
    log.warn(`[Importance] Failed to get importance for ${elementType}.${attributeName}:`, error);
    return IMPORTANCE_LEVELS.OPTIONAL;
  }
}

/**
 * 属性の S2/S4 重要度を取得する
 * @param {string} elementType - 要素タイプ
 * @param {string} attributeName - 属性名
 * @returns {{s2Level: string, s4Level: string}}
 */
function getAttributeMvdImportanceLevels(elementType, attributeName) {
  const attributePath = buildAttributePath(elementType, attributeName);
  if (!attributePath) {
    return {
      s2Level: IMPORTANCE_LEVELS.NOT_APPLICABLE,
      s4Level: IMPORTANCE_LEVELS.NOT_APPLICABLE,
    };
  }

  const manager = getImportanceManager();
  if (manager?.isInitialized && typeof manager.getMvdImportanceLevel === 'function') {
    return {
      s2Level: manager.getMvdImportanceLevel(attributePath, 's2'),
      s4Level: manager.getMvdImportanceLevel(attributePath, 's4'),
    };
  }

  // マネージャー未初期化時はnullを返す（呼び出し側で空として扱う）
  // SETTINGS_CHANGEDイベント受信後に再レンダリングされる
  return null;
}

/**
 * 対象/対象外の2値判定に正規化
 * @param {string} level
 * @returns {boolean}
 */
function isTargetLevel(level) {
  return level !== IMPORTANCE_LEVELS.NOT_APPLICABLE;
}

/**
 * 単一インジケータを描画する
 * @param {boolean} isActive - 対象かどうか
 * @param {string} color - 表示色
 * @param {string} activeTitle - 対象時タイトル
 * @param {string} inactiveTitle - 対象外時タイトル
 * @returns {string}
 */
function renderIndicatorCircle(isActive, color, activeTitle, inactiveTitle) {
  const glyph = isActive ? '&#9679;' : '&#9675;';
  const title = isActive ? activeTitle : inactiveTitle;
  const opacity = isActive ? '1' : '0.65';
  return `<span style="display:inline-block;width:1em;text-align:center;color:${color};font-size:var(--font-size-sm);line-height:1;opacity:${opacity};" title="${title}">${glyph}</span>`;
}

/**
 * S2/S4 の丸インジケータHTMLを取得する
 * XSD赤丸と同様に、属性名セルに表示する。
 *   S2対象 → 🔵（青丸）, S2対象外 → ◯
 *   S4対象 → 🟢（緑丸）, S4対象外 → ◯
 * @param {string} elementType - 要素タイプ
 * @param {string} attributeName - 属性名
 * @returns {string} インジケータのHTML文字列
 */
export function getImportanceCircleHtml(elementType, attributeName) {
  if (!elementType || !attributeName) return '';

  const levels = getAttributeMvdImportanceLevels(elementType, attributeName);
  if (!levels) return ''; // マネージャー未初期化時は空（SETTINGS_CHANGEDで再レンダリング）

  const { s2Level, s4Level } = levels;
  return (
    renderIndicatorCircle(isTargetLevel(s2Level), '#1976D2', 'S2: 対象', 'S2: 対象外') +
    renderIndicatorCircle(isTargetLevel(s4Level), '#388E3C', 'S4: 対象', 'S4: 対象外')
  );
}

/**
 * フルパス指定でS2/S4の丸インジケータHTMLを取得する。
 * XML要素の階層構造から構築した正確なXPathを使用するため、
 * ネストされた断面子要素でも正しい重要度設定を参照できる。
 * @param {string} fullAttributePath - 完全なXPath形式の属性パス
 * @returns {string} インジケータのHTML文字列
 */
export function getImportanceCircleHtmlByPath(fullAttributePath) {
  if (!fullAttributePath) return '';

  const manager = getImportanceManager();
  if (!manager?.isInitialized || typeof manager.getMvdImportanceLevel !== 'function') {
    return '';
  }

  const s2Level = manager.getMvdImportanceLevel(fullAttributePath, 's2');
  const s4Level = manager.getMvdImportanceLevel(fullAttributePath, 's4');

  return (
    renderIndicatorCircle(isTargetLevel(s2Level), '#1976D2', 'S2: 対象', 'S2: 対象外') +
    renderIndicatorCircle(isTargetLevel(s4Level), '#388E3C', 'S4: 対象', 'S4: 対象外')
  );
}
