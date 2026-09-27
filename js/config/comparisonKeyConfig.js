/**
 * @fileoverview 要素比較キーの戦略設定
 * STB要素の対応関係を決定するためのキータイプを定義
 */

/**
 * 要素比較に使用するキーのタイプ
 * @enum {string}
 */
export const COMPARISON_KEY_TYPE = {
  /**
   * 位置情報ベース（ノード位置のみ）: 基準ノード(id_node_start/end)の座標のみをキーとして使用
   * - ノード: X,Y,Z座標
   * - 線分要素（柱・梁・ブレース）: 始点・終点座標
   * - ポリゴン要素（スラブ・壁）: 頂点座標リスト
   * - 最も単純・高速な比較方式（後方互換）
   */
  POSITION_NODE_ONLY: 'position_node',

  /**
   * 位置情報ベース（+オフセット）: 基準ノード座標にオフセット値を加算した座標をキーとして使用
   * - offset_start_X/Y/Z, offset_end_X/Y/Z（線分要素）、StbSlabOffsetList/StbWallOffsetList（ポリゴン要素）を考慮
   * - 配置要素の実際の配置位置を反映する標準的な比較方式
   */
  POSITION_WITH_OFFSET: 'position_offset',

  /**
   * 位置情報ベース（+オフセット+回転角）: ノード座標・オフセット・回転角すべてを考慮した座標をキーとして使用
   * - offset_start_X/Y/Z, offset_end_X/Y/Z, rotate（線分要素）、厚さ（ポリゴン要素）を考慮
   * - 配置位置と向きを完全に比較する精度重視の方式
   */
  POSITION_WITH_ROTATE: 'position_rotate',

  /**
   * GUIDベース: 要素のGUID属性をキーとして使用
   * - GUID属性が存在する場合のみ有効
   * - GUID属性が無い要素は比較対象から除外（「Aのみ」「Bのみ」に分類）
   */
  GUID_BASED: 'guid',

  /**
   * 所属通芯・階ベース: ノードが所属する階名と通芯名をキーとして使用
   * - StbStory / StbParallelAxis の StbNodeIdList で関連付けられた情報を使用
   * - 所属情報が無いノード・要素は比較対象から除外（「Aのみ」「Bのみ」に分類）
   */
  STORY_AXIS_BASED: 'story_axis',

  /**
   * ジオメトリ中心・方向ベース: 部材の中心位置と方向で近似的に対応関係を判定
   * - 線分要素: 中心位置と軸方向
   * - ポリゴン要素: 中心位置と法線方向
   * - Node / Story / Axis など非ジオメトリ要素は位置情報ベースへフォールバック
   */
  GEOMETRY_CENTER_DIRECTION_BASED: 'geometry_center_direction',
};

/**
 * デフォルトの比較キータイプ
 * @type {string}
 */
export const DEFAULT_COMPARISON_KEY_TYPE = COMPARISON_KEY_TYPE.POSITION_NODE_ONLY;

/**
 * キータイプの表示名
 * @type {Object<string, string>}
 */
export const COMPARISON_KEY_TYPE_LABELS = {
  [COMPARISON_KEY_TYPE.POSITION_NODE_ONLY]: '節点位置',
  [COMPARISON_KEY_TYPE.POSITION_WITH_OFFSET]: '節点位置 + オフセット',
  [COMPARISON_KEY_TYPE.POSITION_WITH_ROTATE]: '節点位置 + オフセット + 回転',
  [COMPARISON_KEY_TYPE.GUID_BASED]: 'GUID',
  [COMPARISON_KEY_TYPE.STORY_AXIS_BASED]: '所属通芯・階',
  [COMPARISON_KEY_TYPE.GEOMETRY_CENTER_DIRECTION_BASED]: 'ジオメトリ中心・方向',
};

/**
 * キータイプの説明
 * @type {Object<string, string>}
 */
export const COMPARISON_KEY_TYPE_DESCRIPTIONS = {
  [COMPARISON_KEY_TYPE.POSITION_NODE_ONLY]: 'StbNode座標のみを基準に対応関係を判定します',
  [COMPARISON_KEY_TYPE.POSITION_WITH_OFFSET]:
    'StbNode座標にStb配置オフセット値を加算した位置を基準に対応関係を判定します',
  [COMPARISON_KEY_TYPE.POSITION_WITH_ROTATE]:
    'StbNode座標にStb配置オフセット値と回転角を加味した位置・向きを基準に対応関係を判定します',
  [COMPARISON_KEY_TYPE.GUID_BASED]:
    '要素のGUID属性を基準に対応関係を判定します（GUID無しの要素は比較対象外）',
  [COMPARISON_KEY_TYPE.STORY_AXIS_BASED]:
    'ノードの所属階と所属通芯の名前を基準に対応関係を判定します（所属情報が無い要素は比較対象外）',
  [COMPARISON_KEY_TYPE.GEOMETRY_CENTER_DIRECTION_BASED]:
    '線材は中心位置と軸方向、面材は中心位置と法線方向の近さで対応関係を判定します',
};

/**
 * 断面の対応付け基準。
 * COMPARISON_KEY_TYPE で対応した配置要素について、参照断面を同一の断面として
 * 対応付けるためのキーだけを定義する。対応後の形状・全構成属性の一致判定とは独立する。
 * @enum {string}
 */
export const SECTION_MATCH_CRITERION = {
  /**
   * 配置対応を継承: 断面をキーに入れず、配置要素の対応（上段の判定基準）が取れたペアの
   * 断面を同一とみなす。断面差は配置一致後の型差分として提示する。
   */
  PLACEMENT_INHERIT: 'placement_inherit',
  /** 断面名称: 断面 name（符号）で対応付け。全要素種別に適用。 */
  NAME: 'name',
  /**
   * 断面名称＋StbSecのFloor: 断面 name（符号）と断面要素自身の floor 属性で対応付ける。
   */
  NAME_SECTION_FLOOR: 'name_section_floor',
  /**
   * 断面名称＋配置部材の所属階名: 断面 name（符号）と、配置要素の第一Nodeが
   * StbStoryで所属する階名で対応付ける。
   */
  NAME_MEMBER_STORY: 'name_member_story',
  /** 断面GUID: 断面要素の guid 属性で対応付け（guid が無い断面は配置のみで対応）。 */
  GUID: 'section_guid',
};

/**
 * 既定の断面一致基準（配置対応を継承。旧 AUTO の配置優先挙動を実質引き継ぐ）。
 * @type {string}
 */
export const DEFAULT_SECTION_MATCH_CRITERION = SECTION_MATCH_CRITERION.PLACEMENT_INHERIT;

/**
 * 断面一致基準の表示名
 * @type {Object<string, string>}
 */
export const SECTION_MATCH_CRITERION_LABELS = {
  [SECTION_MATCH_CRITERION.PLACEMENT_INHERIT]: '配置対応を継承',
  [SECTION_MATCH_CRITERION.NAME]: '断面名称',
  [SECTION_MATCH_CRITERION.NAME_SECTION_FLOOR]: '断面名称＋StbSecのFloor',
  [SECTION_MATCH_CRITERION.NAME_MEMBER_STORY]: '断面名称＋配置部材の所属階名',
  [SECTION_MATCH_CRITERION.GUID]: '断面GUID',
};

/**
 * 断面一致基準の説明
 * @type {Object<string, string>}
 */
export const SECTION_MATCH_CRITERION_DESCRIPTIONS = {
  [SECTION_MATCH_CRITERION.PLACEMENT_INHERIT]:
    '配置要素の対応（上段の判定基準）が取れたペアの断面を同一とみなします（断面差は型差分として表示）',
  [SECTION_MATCH_CRITERION.NAME]:
    '断面名称（符号）を基準に対応付けます（片側だけ名称が無い場合は未対応になります）',
  [SECTION_MATCH_CRITERION.NAME_SECTION_FLOOR]:
    '断面名称（符号）とStbSecのfloor属性を基準に対応付けます（片側だけ必要値が無い場合は未対応になります）',
  [SECTION_MATCH_CRITERION.NAME_MEMBER_STORY]:
    '断面名称（符号）と配置要素の第一Nodeが所属するStbStoryの階名を基準に対応付けます（片側だけ必要値が無い場合は未対応になります）',
  [SECTION_MATCH_CRITERION.GUID]:
    '断面要素のGUIDを基準に対応付けます（片側だけGUIDが無い場合は未対応。異ソフト間では通常一致しません）',
};

/**
 * 断面一致基準がノード所属階ルックアップ（buildNodeStoryAxisLookup）を必要とするか。
 * NAME_MEMBER_STORY は第一Nodeの所属階名をキー成分に使うため true。
 * @param {string} criterion - SECTION_MATCH_CRITERION の値
 * @returns {boolean}
 */
export function sectionCriterionNeedsStoryLookup(criterion) {
  return criterion === SECTION_MATCH_CRITERION.NAME_MEMBER_STORY;
}

/**
 * 通り芯・階の対応判定基準: StbStory / StbParallelAxis 等の非描画・非ジオメトリ要素を
 * どう対応付けるか。名前（符号）ベースと幾何位置ベースを切り替える。
 *
 * 名前の表記差（"1F" vs "1FL" 等）だけで別建物/別ソフトのモデルが Aのみ/Bのみ に
 * 落ちるのを避けたい場合に GEOMETRY を選ぶ。既定 NAME は現行挙動と等価。
 * @enum {string}
 */
export const STORY_AXIS_MATCH_CRITERION = {
  /** 名前: name（符号）で対応付け（現行既定）。 */
  NAME: 'name',
  /** 幾何位置: 階=標高、通り芯=原点＋距離から算出した実座標で対応付け（名称差は無視）。 */
  GEOMETRY: 'geometry',
};

/**
 * 既定の通り芯・階の判定基準（名前ベース＝現行挙動）。
 * @type {string}
 */
export const DEFAULT_STORY_AXIS_MATCH_CRITERION = STORY_AXIS_MATCH_CRITERION.NAME;

/**
 * 通り芯・階の判定基準の表示名
 * @type {Object<string, string>}
 */
export const STORY_AXIS_MATCH_CRITERION_LABELS = {
  [STORY_AXIS_MATCH_CRITERION.NAME]: '名前（符号）',
  [STORY_AXIS_MATCH_CRITERION.GEOMETRY]: '幾何位置（階=高さ／通り芯=位置）',
};

/**
 * 通り芯・階の判定基準の説明
 * @type {Object<string, string>}
 */
export const STORY_AXIS_MATCH_CRITERION_DESCRIPTIONS = {
  [STORY_AXIS_MATCH_CRITERION.NAME]: '階名・通り芯名（符号）を基準に対応付けます（現行既定）',
  [STORY_AXIS_MATCH_CRITERION.GEOMETRY]:
    '階は標高、通り芯は原点と距離から算出した実座標を基準に対応付けます（名称の表記差を無視。別ソフト間の同一建物比較向け）',
};

/**
 * 階の幾何位置照合で使用する標高グリッド(mm)。
 * Story の全体比較と Quantity A/B 比較で同一値を使用する。
 */
export const STORY_HEIGHT_MATCH_GRID_MM = 10;

/**
 * StbStory.height を幾何位置照合用の安定キーへ量子化する。
 * @param {number|string|null|undefined} heightMm
 * @returns {number|null} 10mmグリッドの整数キー。無効値は null。
 */
export function quantizeStoryHeightForMatch(heightMm) {
  if (heightMm === null || heightMm === undefined || heightMm === '') return null;
  const height = Number(heightMm);
  if (!Number.isFinite(height)) return null;
  return Math.round(height / STORY_HEIGHT_MATCH_GRID_MM);
}

/**
 * StbStory.height から全体比較で使用するキー文字列を生成する。
 * @param {number|string|null|undefined} heightMm
 * @returns {string|null}
 */
export function buildStoryHeightMatchKey(heightMm) {
  const quantized = quantizeStoryHeightForMatch(heightMm);
  return quantized === null ? null : `story:h:${quantized}`;
}

/**
 * 配置要素比較モード: 線状要素とポリゴン要素の配置位置比較の詳細度
 * COMPARISON_KEY_TYPE の位置情報系3種（POSITION_NODE_ONLY/POSITION_WITH_OFFSET/POSITION_WITH_ROTATE）
 * が内部的に使用するキー生成方式。UIでは COMPARISON_KEY_TYPE として選択され、この値は
 * getPlacementModeForKeyType() を通じて導出される。
 * @enum {string}
 */
export const PLACEMENT_COMPARISON_MODE = {
  /** ノード位置のみ: 基準ノード(id_node_start/end)の座標のみでキーを生成 */
  NODE_POSITION_ONLY: 'nodePositionOnly',
  /** ノード位置 + オフセット: 基準ノード座標とオフセット値を合算した座標でキーを生成 */
  NODE_POSITION_WITH_OFFSET: 'nodePositionWithOffset',
  /** ノード位置 + オフセット + 回転角: ノード、オフセット、回転角すべてを考慮 */
  PLACEMENT_POSITION_COMPLETE: 'placementPositionComplete',
};

/**
 * 比較キータイプから、対応する配置要素比較モードを導出する。
 * 位置情報系3種以外のキータイプ（GUID / 所属通芯・階 / ジオメトリ中心・方向）は
 * ノード位置のみ相当（Mode1）を返す。
 * @param {string} keyType - COMPARISON_KEY_TYPE の値
 * @returns {string} PLACEMENT_COMPARISON_MODE の値
 */
export function getPlacementModeForKeyType(keyType) {
  switch (keyType) {
    case COMPARISON_KEY_TYPE.POSITION_WITH_OFFSET:
      return PLACEMENT_COMPARISON_MODE.NODE_POSITION_WITH_OFFSET;
    case COMPARISON_KEY_TYPE.POSITION_WITH_ROTATE:
      return PLACEMENT_COMPARISON_MODE.PLACEMENT_POSITION_COMPLETE;
    default:
      return PLACEMENT_COMPARISON_MODE.NODE_POSITION_ONLY;
  }
}
