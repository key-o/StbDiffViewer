/**
 * @fileoverview 断面抽出統一設定
 *
 * 全要素タイプの断面データ抽出設定を一元管理します。
 * 新要素追加時は、この設定にエントリを追加するだけで
 * 自動的にシステム全体に反映されます。
 *
 * @module common/stb/section/sectionConfig
 */

/**
 * 要素タイプ別断面設定
 * 各要素タイプの抽出ルールを定義
 *
 * @typedef {Object} SectionConfigEntry
 * @property {string[]} selectors - 断面XMLタグ名の配列
 * @property {Object} [attributeFilter] - 属性フィルタリング条件
 * @property {string[]} [skipFilterForTags] - フィルターをスキップするタグ名
 * @property {boolean} [skipFilterIfAttributeMissing] - 属性欠如時にフィルターをスキップ
 * @property {string[]} [steelFigures] - 鋼材図形タグ名の配列
 * @property {string[]} [concreteFigures] - コンクリート図形タグ名の配列
 * @property {string[]} [barArrangements] - 配筋配置コンテナタグ名（かぶり情報等）
 * @property {string[]} [barElements] - 配筋詳細タグ名（主筋・帯筋の径・本数等）
 */

/**
 * 要素タイプ別断面設定
 * @type {Object.<string, SectionConfigEntry>}
 */
export const SECTION_CONFIG = {
  // ==========================================================================
  // 柱・間柱
  // ==========================================================================

  Column: {
    selectors: ['StbSecColumn_RC', 'StbSecColumn_S', 'StbSecColumn_SRC', 'StbSecColumn_CFT'],
    // 注: attributeFilterは設定しない。間柱(POST)がkind_column="POST"で
    // フィルタリングされるため、それ以外（属性なし、COLUMN等）が自動的に柱となる
    steelFigures: [
      'StbSecSteelFigureColumn_S',
      'StbSecSteelFigureColumn_CFT',
      'StbSecSteelFigureColumn_SRC',
    ],
    // RCでは図形フィギュア要素だけでなく、直下にRect/Circle要素が来る形式もある
    // 例: <StbSecColumn_RC> <StbSecColumn_RC_Rect width_X="500" width_Y="500"/> </StbSecColumn_RC>
    // これらも寸法抽出の対象に含める
    concreteFigures: [
      'StbSecFigureColumn_RC',
      'StbSecFigureColumn_SRC',
      // 直下定義のRC図形
      'StbSecColumn_RC_Rect',
      'StbSecColumn_RC_Circle',
      // 将来拡張（SRC/CFTでも直下定義されるケース用、存在しなくても問題なし）
      'StbSecColumn_SRC_Rect',
      'StbSecColumn_SRC_Circle',
      'StbSecColumn_CFT_Rect',
      'StbSecColumn_CFT_Circle',
    ],
    // RC配筋配置コンテナ（かぶり情報等を含む）
    barArrangements: ['StbSecBarArrangementColumn_RC'],
    // RC配筋詳細要素（主筋・帯筋の径・本数・ピッチ等）
    barElements: [
      'StbSecBarColumn_RC_RectSame', // 矩形断面・同一配筋
      'StbSecBarColumn_RC_RectNotSame', // 矩形断面・異なる配筋
      'StbSecBarColumn_RC_CircleSame', // 円形断面・同一配筋
      'StbSecBarColumn_RC_CircleNotSame', // 円形断面・異なる配筋
    ],
  },

  Post: {
    // 間柱は柱の断面タグを使用し、kind_column="POST" で区別する
    selectors: ['StbSecColumn_RC', 'StbSecColumn_S', 'StbSecColumn_SRC', 'StbSecColumn_CFT'],
    // kind_column属性でフィルタリング
    attributeFilter: {
      kind_column: 'POST',
    },
    steelFigures: [
      'StbSecSteelFigureColumn_S',
      'StbSecSteelFigureColumn_CFT',
      'StbSecSteelFigureColumn_SRC',
    ],
    // 間柱もRC図形を持つ可能性がある
    concreteFigures: [
      'StbSecFigureColumn_RC',
      'StbSecFigureColumn_SRC',
      // 直下定義のRC図形
      'StbSecColumn_RC_Rect',
      'StbSecColumn_RC_Circle',
      // 将来拡張
      'StbSecColumn_SRC_Rect',
      'StbSecColumn_SRC_Circle',
      'StbSecColumn_CFT_Rect',
      'StbSecColumn_CFT_Circle',
    ],
    // RC配筋配置コンテナ（かぶり情報等を含む）
    barArrangements: ['StbSecBarArrangementColumn_RC'],
    // RC配筋詳細要素（主筋・帯筋の径・本数・ピッチ等）
    barElements: [
      'StbSecBarColumn_RC_RectSame',
      'StbSecBarColumn_RC_RectNotSame',
      'StbSecBarColumn_RC_CircleSame',
      'StbSecBarColumn_RC_CircleNotSame',
    ],
  },

  // ==========================================================================
  // 梁（大梁・小梁）
  // ==========================================================================

  // 大梁断面: StbSecGirder_* と StbSecBeam_* (kind_beam="GIRDER") の両方を含む
  Girder: {
    selectors: [
      'StbSecGirder_RC',
      'StbSecGirder_S',
      'StbSecGirder_SRC',
      'StbSecBeam_RC',
      'StbSecBeam_S',
      'StbSecBeam_SRC',
    ],
    // kind_beam属性でフィルタリング（StbSecGirder_* はフィルター適用外）
    attributeFilter: {
      kind_beam: 'GIRDER',
    },
    // StbSecGirder_* タグはフィルターをスキップ（常に大梁として扱う）
    skipFilterForTags: ['StbSecGirder_RC', 'StbSecGirder_S', 'StbSecGirder_SRC'],
    // kind_beam属性がない場合も大梁として扱う（デフォルトGIRDER）
    skipFilterIfAttributeMissing: true,
    steelFigures: [
      'StbSecSteelFigureGirder_S',
      'StbSecSteelFigureBeam_S',
      'StbSecSteelFigureGirder_SRC',
      'StbSecSteelFigureBeam_SRC',
    ],
    concreteFigures: [
      'StbSecFigureGirder_RC',
      'StbSecFigureBeam_RC',
      'StbSecFigureGirder_SRC',
      'StbSecFigureBeam_SRC',
      // 直下定義のRC図形
      'StbSecGirder_RC_Rect',
      'StbSecBeam_RC_Rect',
    ],
    // RC配筋配置コンテナ（かぶり情報等を含む）
    barArrangements: ['StbSecBarArrangementBeam_RC', 'StbSecBarArrangementGirder_RC'],
    // RC配筋詳細要素（主筋・あばら筋の径・本数・ピッチ等）
    barElements: [
      'StbSecBarBeam_RC_Same', // 同一配筋
      'StbSecBarBeam_RC_NotSame', // 異なる配筋（端部・中央）
      'StbSecBarGirder_RC_Same',
      'StbSecBarGirder_RC_NotSame',
    ],
  },

  // 小梁断面: StbSecBeam_* (kind_beam="BEAM") のみ
  Beam: {
    selectors: ['StbSecBeam_RC', 'StbSecBeam_S', 'StbSecBeam_SRC'],
    // kind_beam属性でフィルタリング
    attributeFilter: {
      kind_beam: 'BEAM',
    },
    steelFigures: ['StbSecSteelFigureBeam_S', 'StbSecSteelFigureBeam_SRC'],
    concreteFigures: [
      'StbSecFigureBeam_RC',
      'StbSecFigureBeam_SRC',
      // 直下定義のRC図形
      'StbSecBeam_RC_Rect',
    ],
    // RC配筋配置コンテナ（かぶり情報等を含む）
    barArrangements: ['StbSecBarArrangementBeam_RC'],
    // RC配筋詳細要素（主筋・あばら筋の径・本数・ピッチ等）
    barElements: ['StbSecBarBeam_RC_Same', 'StbSecBarBeam_RC_NotSame'],
  },

  // ==========================================================================
  // ブレース
  // ==========================================================================

  Brace: {
    selectors: ['StbSecBrace_S'],
    steelFigures: ['StbSecSteelFigureBrace_S'],
  },

  // ==========================================================================
  // 杭・基礎要素
  // ==========================================================================

  Pile: {
    selectors: ['StbSecPile_RC', 'StbSecPile_S', 'StbSecPileProduct', 'StbSecPilePrecast'],
    steelFigures: ['StbSecSteelFigurePile_S', 'StbSecFigurePile_S'],
    concreteFigures: [
      'StbSecFigurePile_RC',
      // RC杭の断面形状タイプ (STB 2.0.2)
      'StbSecPile_RC_Straight', // 直杭
      'StbSecPile_RC_ExtendedFoot', // 根固め部拡大杭
      'StbSecPile_RC_ExtendedTop', // 頭部拡大杭
      'StbSecPile_RC_ExtendedTopFoot', // 頭部・根固め部拡大杭
      'StbSecPile_RC_Rect',
      'StbSecPile_RC_Circle',
      // STB 2.1.0 の杭断面構造
      'StbSecPile_RC_Conventional', // 在来杭（ラッパー）
      'StbSecFigurePile_RC_Conventional', // 在来杭図形コンテナ
      'StbSecPile_RC_ConventionalStraight', // 在来直杭（D属性で直径を持つ）
      'StbSecPile_RC_ConventionalExtendedFoot', // 在来根固め部拡大杭
      'StbSecPile_RC_ConventionalExtendedTop', // 在来頭部拡大杭
      'StbSecPile_RC_ConventionalExtendedTopFoot', // 在来頭部・根固め部拡大杭
    ],
  },

  Footing: {
    selectors: ['StbSecFoundation_RC'],
    concreteFigures: [
      'StbSecFigureFoundation_RC',
      'StbSecFoundation_RC_Rect',
      'StbSecFoundation_RC_Circle',
    ],
  },

  FoundationColumn: {
    selectors: [
      'StbSecFoundationColumn_RC',
      'StbSecFoundationColumn_S',
      'StbSecFoundationColumn_SRC',
    ],
    steelFigures: ['StbSecSteelFigureFoundationColumn_S', 'StbSecSteelFigureFoundationColumn_SRC'],
    concreteFigures: [
      'StbSecFigureFoundationColumn_RC',
      'StbSecFigureFoundationColumn_SRC',
      'StbSecFoundationColumn_RC_Rect',
      'StbSecFoundationColumn_RC_Circle',
    ],
  },

  // ==========================================================================
  // 床・壁要素
  // ==========================================================================

  Slab: {
    selectors: [
      'StbSecSlab_RC',
      'StbSecSlab_S',
      'StbSecSlab_SRC',
      'StbSecSlabDeck', // デッキスラブ
      'StbSecSlabPrecast', // プレキャストスラブ
    ],
    concreteFigures: [
      'StbSecFigureSlab_RC',
      'StbSecFigureSlabDeck',
      'StbSecFigureSlabPrecast',
      // 直下定義
      'StbSecSlab_RC_Straight', // 均一厚スラブ
      'StbSecSlab_RC_Taper', // テーパースラブ
      'StbSecSlab_RC_Haunch', // ハンチスラブ
      'StbSecSlab_RC_Hollow', // 中空スラブ
      'StbSecSlab_RC_Waffle', // ワッフルスラブ
      'StbSecSlabDeckStraight',
      'StbSecSlabPrecastStraight',
    ],
  },

  Wall: {
    selectors: ['StbSecWall_RC', 'StbSecWall_S', 'StbSecWall_SRC'],
    steelFigures: ['StbSecSteelFigureWall_S', 'StbSecSteelFigureWall_SRC'],
    concreteFigures: [
      'StbSecFigureWall_RC',
      // 直下定義
      'StbSecWall_RC_Straight', // 均一厚壁
    ],
  },

  // ==========================================================================
  // パラペット（壁上の立ち上がり部材）
  // ==========================================================================

  Parapet: {
    selectors: ['StbSecParapet_RC'],
    concreteFigures: [
      'StbSecFigureParapet_RC',
      'StbSecParapet_RC_TypeI', // I型断面 (t_T: 厚さ, depth_H: 高さ)
      'StbSecParapet_RC_TypeL', // L型断面
    ],
  },

  // ==========================================================================
  // 未定義断面（Undefined）
  // StbSecUndefinedは寸法情報を持たない汎用的なプレースホルダー断面
  // 柱・梁など様々な要素タイプで使用される可能性がある
  // ==========================================================================

  Undefined: {
    selectors: ['StbSecUndefined'],
    // 寸法情報を持たないため、steelFigures/concreteFiguresは不要
  },

  // ==========================================================================
  // 免震装置
  // ==========================================================================

  IsolatingDevice: {
    selectors: ['StbSecIsolatingDevice'],
  },

  // ==========================================================================
  // 制振装置
  // ==========================================================================

  DampingDevice: {
    selectors: ['StbSecDampingDevice'],
  },
};

/**
 * 設定の妥当性を検証
 * @returns {Array<string>} エラーメッセージの配列（空配列なら正常）
 */
export function validateSectionConfig() {
  const errors = [];

  for (const [elementType, config] of Object.entries(SECTION_CONFIG)) {
    // selectors必須チェック
    if (!config.selectors || config.selectors.length === 0) {
      errors.push(`${elementType}: selectors is required`);
      continue;
    }

    // セレクター形式チェック
    config.selectors.forEach((selector) => {
      if (!selector.match(/^StbSec\w+$/)) {
        errors.push(`${elementType}: Invalid selector format: ${selector}`);
      }
    });

    // 図形マッピング整合性チェック
    if (config.steelFigures) {
      config.steelFigures.forEach((figure) => {
        if (!figure.match(/^StbSec.*Figure/)) {
          errors.push(`${elementType}: Invalid steel figure format: ${figure}`);
        }
      });
    }
  }

  return errors;
}

/**
 * サポートされている要素タイプの一覧を取得
 * @returns {Array<string>} 要素タイプ配列
 */
export function getSupportedElementTypes() {
  return Object.keys(SECTION_CONFIG);
}
