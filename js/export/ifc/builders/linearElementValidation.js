/**
 * @fileoverview 線形要素（梁・柱・ブレース）データのバリデーション
 * IFCBeamExporter から分離した純粋関数
 * @module export/ifc/builders/linearElementValidation
 */

/**
 * 線形要素データのバリデーション（梁・柱・ブレース共通）
 * @param {Object} data - バリデーション対象オブジェクト
 * @param {string} elementType - 要素型の日本語名（例: '梁', '柱', 'ブレース'）
 * @param {Object} pointFieldNames - ポイントフィールド名
 * @param {string} pointFieldNames.point1 - 第1ポイントのフィールド名（例: 'startPoint'）
 * @param {string} pointFieldNames.point2 - 第2ポイントのフィールド名（例: 'endPoint'）
 * @returns {Object} バリデーション結果
 * @returns {boolean} result.isValid - バリデーション成功フラグ
 * @returns {string} [result.error] - エラーメッセージ（失敗時）
 * @returns {Object} [result.point1] - 第1ポイント（成功時）
 * @returns {Object} [result.point2] - 第2ポイント（成功時）
 * @returns {Object} [result.profile] - プロファイル（成功時）
 * @returns {number} [result.length] - ポイント間の距離（成功時）
 * @returns {number} [result.rotation] - 回転値（成功時）
 */
export function validateLinearElementData(data, elementType, pointFieldNames) {
  // Step 1: データオブジェクト自体のチェック
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      isValid: false,
      error: `${elementType}データは null でないオブジェクトである必要があります`,
    };
  }

  const point1Name = pointFieldNames.point1;
  const point2Name = pointFieldNames.point2;
  const point1 = data[point1Name];
  const point2 = data[point2Name];
  const profile = data.profile;

  // Step 2: 必須パラメータのチェック
  if (!point1 || !point2 || !profile) {
    return {
      isValid: false,
      error: `${elementType}の必須パラメータが不足しています: ${point1Name}, ${point2Name}, profile`,
    };
  }

  // Step 3: ポイント1のオブジェクト妥当性チェック
  if (
    typeof point1 !== 'object' ||
    typeof point1.x !== 'number' ||
    typeof point1.y !== 'number' ||
    typeof point1.z !== 'number'
  ) {
    return {
      isValid: false,
      error: `${elementType}の${point1Name}は数値プロパティ x, y, z を持つオブジェクトである必要があります`,
    };
  }

  // Step 4: ポイント2のオブジェクト妥当性チェック
  if (
    typeof point2 !== 'object' ||
    typeof point2.x !== 'number' ||
    typeof point2.y !== 'number' ||
    typeof point2.z !== 'number'
  ) {
    return {
      isValid: false,
      error: `${elementType}の${point2Name}は数値プロパティ x, y, z を持つオブジェクトである必要があります`,
    };
  }

  // Step 5: プロファイルのオブジェクト妥当性チェック
  if (typeof profile !== 'object' || !profile.type) {
    return {
      isValid: false,
      error: `${elementType}のプロファイルはtype プロパティを持つオブジェクトである必要があります`,
    };
  }

  // Step 6: 回転値のチェック
  const rotation = data.rotation ?? 0;
  if (typeof rotation !== 'number' || !isFinite(rotation)) {
    return {
      isValid: false,
      error: `${elementType}の回転値は有限数である必要があります`,
    };
  }

  // Step 7: ポイント間の距離計算と0チェック
  const dx = point2.x - point1.x;
  const dy = point2.y - point1.y;
  const dz = point2.z - point1.z;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (length < 1e-6) {
    return {
      isValid: false,
      error: `${elementType}の長さが0です`,
    };
  }

  return {
    isValid: true,
    point1,
    point2,
    profile,
    length,
    rotation,
  };
}
