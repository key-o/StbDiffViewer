/**
 * @fileoverview ST-Bridge 修復エンジンの SDV 向けアダプター
 *
 * 修復ロジックの正本はアプリ非依存の import カーネルに置き、ここでは
 * SDV 固有のパーサーとバリデーション機能を DI で配線します。
 * 従来の import パスと公開 API は再エクスポートで維持します。
 *
 * @module common-stb/repair/stbRepairEngine
 */

import { parseElements } from '../import/parser/stbXmlParser.js';
import { setValidatorFunctions } from '../import/repair/stbRepairEngine.js';
import { CATEGORY, SEVERITY } from '../validation/validationConstants.js';
import { getRepairableIssues } from '../validation/stbValidator.js';

// カーネルはデフォルト無効のため、旧 SDV エントリーポイントの評価時に
// 従来と同じアプリ固有依存を注入してから公開 API を利用可能にする。
setValidatorFunctions({
  parseElements,
  SEVERITY,
  CATEGORY,
  getRepairableIssues,
});

export {
  StbRepairEngine,
  formatRepairReport,
  autoRepairDocument,
  REPAIR_ACTION,
} from '../import/repair/stbRepairEngine.js';
