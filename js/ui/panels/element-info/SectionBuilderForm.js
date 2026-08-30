/**
 * @fileoverview スキーマ駆動 断面ビルダーフォーム
 *
 * 汎用 SchemaElementBuilderForm を StbSections 用に構成する薄いラッパー。
 * 同型断面のコピー、XSD choice / sequence / cardinality、属性検証は共通実装へ委譲する。
 *
 * @module ui/panels/element-info/SectionBuilderForm
 */

import { addNewSectionElement } from './editMode/index.js';
import { openSchemaElementBuilder } from './SchemaElementBuilderForm.js';

const ELEMENT_LABELS = {
  StbSecColumn_RC: 'RC柱断面',
  StbSecColumn_S: 'S柱断面',
  StbSecColumn_SRC: 'SRC柱断面',
  StbSecColumn_CFT: 'CFT柱断面',
  StbSecBeam_RC: 'RC梁断面',
  StbSecBeam_S: 'S梁断面',
  StbSecBeam_SRC: 'SRC梁断面',
  StbSecBrace_S: 'Sブレース断面',
  StbSecSlab_RC: 'RCスラブ断面',
  StbSecSlabDeck: 'デッキプレートスラブ断面',
  StbSecSlabPrecast: '既製スラブ断面',
  StbSecSlabLoad: '荷重スラブ断面',
  StbSecWall_RC: 'RC壁断面',
  StbSecWallLoad: '荷重壁断面',
  StbSecFoundation_RC: 'RC基礎断面',
  StbSecPile_RC: 'RC杭断面',
  StbSecPile_S: '鋼管杭断面',
  StbSecPileProduct: '既製コンクリート杭断面',
  StbSecOpen_RC: 'RC開口補強断面',
  StbSecParapet_RC: 'RCパラペット断面',
  StbSecUndefined: '未定義断面',
  StbSecFigureColumn_RC: '形状',
  StbSecBarArrangementColumn_RC: '配筋',
  StbSecColumn_RC_Rect: '矩形',
  StbSecColumn_RC_Circle: '円形',
  StbSecBarColumn_RC_RectSame: '矩形（同一）',
  StbSecBarColumn_RC_RectNotSame: '矩形（上下別）',
  StbSecBarColumn_RC_CircleSame: '円形（同一）',
  StbSecBarColumn_RC_CircleNotSame: '円形（上下別）',
  StbSecBarColumnXReinforced: 'X 補強',
  StbSecBarArrangementOpen_RC: '開口補強筋',
  StbSecBarOpen_RC_Slab: '床開口補強筋',
  StbSecBarOpen_RC_Wall: '壁開口補強筋',
};

function labelFor(name) {
  return ELEMENT_LABELS[name] || name;
}

function normalizeOptions(optionsOrRoot) {
  if (typeof optionsOrRoot === 'string' || optionsOrRoot == null) {
    const root = optionsOrRoot || 'StbSecColumn_RC';
    return { rootElementNames: [root], initialRootElementName: root };
  }
  const roots = Array.isArray(optionsOrRoot.rootElementNames)
    ? [...new Set(optionsOrRoot.rootElementNames.filter(Boolean))]
    : [];
  return {
    rootElementNames: roots,
    initialRootElementName: optionsOrRoot.initialRootElementName || roots[0] || 'StbSecColumn_RC',
  };
}

/**
 * 断面ビルダーモーダルを開く。
 * @param {string|{rootElementNames:string[],initialRootElementName?:string}} [optionsOrRoot]
 * @returns {Promise<{id:string,tagName:string}|null>}
 */
export function openSectionBuilder(optionsOrRoot = 'StbSecColumn_RC') {
  const options = normalizeOptions(optionsOrRoot);
  return openSchemaElementBuilder({
    schemaContainerName: 'StbSections',
    rootElementNames: options.rootElementNames,
    initialRootElementName: options.initialRootElementName,
    rootSelectLabel: '断面種別',
    copySelectLabel: 'コピー元',
    emptyCopyLabel: '（コピーしない：空の断面から作成）',
    labelFor,
    titleForRoot: (rootName) => `新規断面の作成（${labelFor(rootName)}）`,
    addElement: addNewSectionElement,
  });
}
