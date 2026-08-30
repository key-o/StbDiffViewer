/**
 * @fileoverview 断面ツリービュー
 *
 * 断面ごとに配置要素をグループ化して表示するツリービュー機能を提供します。
 * - 断面タイプ別の階層表示（柱断面、梁断面など）
 * - 各断面を使用している配置要素のリスト表示
 * - 階ごと・符号ごとのグループ化オプション
 * - 断面選択時に使用要素を一括ハイライト（将来の複数選択機能）
 * - テキスト検索（断面ID、断面名）
 * - 正規表現サポート（/pattern/ 形式）
 */

import {
  parseSearchPattern,
  matchesSectionSearch,
  DEFAULT_SECTION_TARGET_FILTER,
} from './treeSearch.js';
import { createLogger } from '../../utils/logger.js';
import { BaseTreeView } from './BaseTreeView.js';
import { sectionTreeGroupingMethods } from './sectionTree/sectionTreeGrouping.js';
import { sectionTreeNodeMethods } from './sectionTree/sectionTreeNodes.js';
import { sectionTreeContextMenuMethods } from './sectionTree/sectionTreeContextMenu.js';

const log = createLogger('sectionTreeView');

const SECTION_MAP_KEY_BY_ELEMENT_TYPE = {
  Column: 'columnSections',
  Girder: 'girderSections',
  Beam: 'beamSections',
  Brace: 'braceSections',
  Slab: 'slabSections',
  ShearWall: 'wallSections',
  Wall: 'wallSections',
};

class SectionTreeView extends BaseTreeView {
  constructor() {
    super({
      name: 'sectionTree',
      emptyMessage: '断面データがありません',
      searchPlaceholder: '検索... (/正規表現/)',
      showStatusFilter: false,
      searchTargetOptions: [
        { key: 'sectionId', label: '断面ID' },
        { key: 'sectionName', label: '断面名' },
        { key: 'shapeName', label: '形状名' },
      ],
      defaultTargetFilter: DEFAULT_SECTION_TARGET_FILTER,
    });

    /** @type {string} グループ化モード: 'floor' (階ごと) または 'code' (符号ごと) */
    this.groupingMode = 'floor';

    /** @type {Object} 現在の断面データ（検索再実行用） */
    this.currentSectionsData = null;

    /** @type {{total: number, filtered: number}} 断面統計（全体・フィルタ後） */
    this.sectionStats = { total: 0, filtered: 0 };
  }

  // --- テンプレートメソッド オーバーライド ---

  /** 初期化完了時フック */
  _onInitialized() {
    log.info('Section tree view initialized');
  }

  /** 検索クリア時フック */
  _onSearchClear() {
    this.currentSearchText = '';
    this.currentTargetFilter = { ...DEFAULT_SECTION_TARGET_FILTER };
  }

  /**
   * ツリーを再構築
   */
  rebuild() {
    this.buildSectionTree(this.currentComparisonResult, this.currentSectionsData);
  }

  // --- 公開メソッド ---

  /**
   * グループ化モードを設定
   * @param {string} mode - 'floor' または 'code'
   */
  setGroupingMode(mode) {
    if (['floor', 'code'].includes(mode)) {
      this.groupingMode = mode;
      log.info(`Grouping mode set to: ${mode}`);
    } else {
      log.warn(`Invalid grouping mode: ${mode}`);
    }
  }

  /**
   * 比較結果から断面ツリーを構築
   * @param {Object} comparisonResult - 比較結果 {matched: [], onlyA: [], onlyB: []}
   * @param {Object} sectionsData - 断面データ {columnSections: Map, girderSections: Map, ...}
   */
  buildSectionTree(comparisonResult, sectionsData) {
    if (!this.treeContainer) {
      log.error('Tree container not initialized');
      return;
    }

    // 再検索用にデータを保存
    this.currentComparisonResult = comparisonResult;
    this.currentSectionsData = sectionsData;

    if (!sectionsData) {
      log.warn('sectionsData is null or undefined');
      this.clearTreeContent();

      // 空のメッセージを表示
      const emptyMessage = document.createElement('div');
      emptyMessage.className = 'section-tree-empty-message';
      emptyMessage.style.cssText = 'padding: 10px; text-align: center; color: #666;';
      emptyMessage.textContent = '断面データがありません';
      this.treeContainer.appendChild(emptyMessage);
      this.sectionStats = { total: 0, filtered: 0 };
      this.updateResultCount(0, 0);
      return;
    }

    this.clearTreeContent();

    // 検索パターンを解析
    const searchPattern = parseSearchPattern(this.currentSearchText);

    // 断面の使用状況マップを作成
    const sectionUsageMap = this._createSectionUsageMap(comparisonResult);

    log.info('Section usage map:', sectionUsageMap);

    // 断面タイプごとにツリーノードを作成
    const sectionTypes = ['Column', 'Girder', 'Beam', 'Brace', 'Slab', 'ShearWall', 'Wall'];

    this.sectionStats = { total: 0, filtered: 0 };

    sectionTypes.forEach((elementType) => {
      const sectionMapKey =
        SECTION_MAP_KEY_BY_ELEMENT_TYPE[elementType] || `${elementType.toLowerCase()}Sections`;
      const sectionMap = sectionsData[sectionMapKey];

      if (!sectionMap || sectionMap.size === 0) return;

      // この要素タイプで実際に使用されている断面のみを抽出
      const usedSections = [];
      sectionMap.forEach((sectionData, sectionId) => {
        const usage = sectionUsageMap[elementType]?.[sectionId];
        if (usage && usage.length > 0) {
          usedSections.push({
            sectionId,
            sectionData,
            elements: usage,
          });
        }
      });

      if (usedSections.length === 0) return;

      // 全断面数をカウント
      this.sectionStats.total += usedSections.length;

      // 検索フィルタリングを適用
      const filteredSections = usedSections.filter((section) =>
        matchesSectionSearch(section, searchPattern, this.currentTargetFilter),
      );

      this.sectionStats.filtered += filteredSections.length;

      if (filteredSections.length === 0) return;

      // 断面タイプノードを作成
      const typeNode = this._createSectionTypeNode(elementType, filteredSections, searchPattern);
      this.treeContainer.appendChild(typeNode);
    });

    // ツリーが空の場合、メッセージを表示
    const hasContent = Array.from(this.treeContainer.children).some(
      (child) => !child.classList.contains('tree-search-container'),
    );

    if (!hasContent) {
      const emptyMessage = document.createElement('div');
      emptyMessage.className = 'section-tree-no-result-message';
      emptyMessage.style.cssText = 'padding: 20px; text-align: center; color: #868e96;';
      emptyMessage.textContent = this.currentSearchText
        ? '検索条件に一致する断面がありません'
        : '使用されている断面がありません';
      this.treeContainer.appendChild(emptyMessage);
    }

    // 検索結果数を更新
    this.updateResultCount(this.sectionStats.filtered, this.sectionStats.total);
  }

  /**
   * 検索をリセット
   */
  resetSearch() {
    this.currentSearchText = '';
    this.currentTargetFilter = { ...DEFAULT_SECTION_TARGET_FILTER };
    if (this.searchUI) {
      this.searchUI.reset();
    }
    if (this.currentComparisonResult && this.currentSectionsData) {
      this.buildSectionTree(this.currentComparisonResult, this.currentSectionsData);
    }
  }

  /**
   * 検索テキストを設定して検索を実行
   * @param {string} searchText - 検索テキスト
   */
  setSearchText(searchText) {
    this.currentSearchText = searchText;
    if (this.currentComparisonResult && this.currentSectionsData) {
      this.buildSectionTree(this.currentComparisonResult, this.currentSectionsData);
    }
  }
}

// 責務ごとに分割したメソッド群をプロトタイプへ合成
// （可変状態は SectionTreeView インスタンスにのみ存在する）
Object.assign(
  SectionTreeView.prototype,
  sectionTreeGroupingMethods,
  sectionTreeNodeMethods,
  sectionTreeContextMenuMethods,
);

// シングルトンインスタンス
const instance = new SectionTreeView();

// 既存APIとの互換ラッパー関数

/**
 * 断面ツリービューを初期化
 * @param {string} containerId - ツリーを表示するコンテナーのID
 * @param {Function} onElementSelect - 要素選択時のコールバック
 * @param {Object} [options] - オプション
 * @param {Function} [options.onContextMenuAction] - コンテキストメニューアクションのコールバック
 */
export function initializeSectionTreeView(containerId, onElementSelect, options) {
  instance.initialize(containerId, onElementSelect, options);
}

/**
 * 比較結果から断面ツリーを構築
 * @param {Object} comparisonResult - 比較結果
 * @param {Object} sectionsData - 断面データ
 */
export function buildSectionTree(comparisonResult, sectionsData) {
  instance.buildSectionTree(comparisonResult, sectionsData);
}

/**
 * グループ化モードを設定
 * @param {string} mode - 'floor' または 'code'
 */
export function setGroupingMode(mode) {
  instance.setGroupingMode(mode);
}

/**
 * 断面ツリーをクリア
 */
export function clearSectionTree() {
  instance.clearTree();
}

/**
 * 検索をリセット
 */
export function resetSectionSearch() {
  instance.resetSearch();
}

/**
 * 検索テキストを設定して検索を実行
 * @param {string} searchText - 検索テキスト
 */
export function setSectionSearchText(searchText) {
  instance.setSearchText(searchText);
}
