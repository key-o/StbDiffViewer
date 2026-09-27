import { storageHelper } from '../../../utils/storageHelper.js';
import { createLogger } from '../../../utils/logger.js';
import { getState } from '../../../data/state/globalState.js';
import {
  renderComparisonRecursive,
  renderSectionInfo,
  renderOpeningInfo,
  generateTableStyles,
  setupCollapseHandlers,
} from './ComparisonRenderer.js';
import {
  buildComparisonHeaderHtml,
  buildSingleColumnHeaderHtml,
  resolveElementInfoModelSide,
  shouldUseSingleColumnElementInfo,
} from './DisplayModelResolver.js';
import { renderQuantityInfoFromStores } from './QuantityInfoRenderer.js';
import { renderElementInfoTabs, setupElementInfoTabs } from './ElementInfoTabs.js';
import { generateValidationInfoHtml } from '../../../common-stb/validation/validationHtmlRenderer.js';
import { escapeHtml, valueToSafeHtml } from '../../../utils/htmlUtils.js';

const logger = createLogger('viewer:element-info');

export let storedPanelWidth = storageHelper.get('panelWidth');
export let storedPanelHeight = storageHelper.get('panelHeight');

const DEFAULT_ELEMENT_INFO_MESSAGE = '要素を選択してください。';

/**
 * 要素情報パネルのタイトル(<h3>)の HTML を生成する。
 *
 * title は呼び出し側(ElementInfoController)で組み立て済みの安全な HTML 断片で、
 * XSD/評価バッジ等の <span> マークアップを含み、動的値(要素ID・型名・ファイル名など)は
 * 構築時にエスケープ済み。ここで再度 escapeHtml するとマークアップが文字列として
 * 表示されてしまう(回帰: commit e675b9ed)。showInfo と showJointMeshDataOnly の
 * 描画経路をこの関数に一本化し、テストが本番と同じ出力を検証できるようにする。
 *
 * @param {string} title - エスケープ済みの安全な HTML タイトル断片
 * @returns {string} `<h3>...</h3>` の HTML
 */
export function renderElementInfoTitleHtml(title) {
  return `<h3>${title}</h3>`;
}

export function clearElementInfoDisplayState(
  contentDiv = null,
  { renderEmptyMessage = false } = {},
) {
  if (contentDiv && renderEmptyMessage) {
    contentDiv.textContent = DEFAULT_ELEMENT_INFO_MESSAGE;
  }
}

export function setupPanelResizeObserver(panel) {
  if (panel.hasResizeObserver) return;

  let resizeTimeout;
  let userIsResizing = false;
  const lastKnownSize = { width: 0, height: 0 };

  panel.addEventListener('mousedown', (e) => {
    const rect = panel.getBoundingClientRect();
    const isNearRightBorder = e.clientX > rect.right - 20;
    const isNearBottomBorder = e.clientY > rect.bottom - 20;

    if (isNearRightBorder || isNearBottomBorder) {
      userIsResizing = true;
      lastKnownSize.width = panel.offsetWidth;
      lastKnownSize.height = panel.offsetHeight;
    }
  });

  panel.addEventListener('initializeSize', (e) => {
    lastKnownSize.width = e.detail.width;
    lastKnownSize.height = e.detail.height;
  });

  document.addEventListener('mouseup', () => {
    if (userIsResizing) {
      setTimeout(() => {
        const currentWidth = panel.offsetWidth;
        const currentHeight = panel.offsetHeight;

        if (currentWidth !== lastKnownSize.width || currentHeight !== lastKnownSize.height) {
          if (currentWidth > 300) {
            storedPanelWidth = `${currentWidth}px`;
            storageHelper.set('panelWidth', storedPanelWidth);
          }
          if (currentHeight > 100) {
            storedPanelHeight = `${currentHeight}px`;
            storageHelper.set('panelHeight', storedPanelHeight);
          }
        }

        userIsResizing = false;
      }, 100);
    }
  });

  const resizeObserver = new ResizeObserver((_entries) => {
    if (panel._ignoreResize) {
      return;
    }

    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (panel._ignoreResize) {
        return;
      }

      const currentWidth = panel.offsetWidth;
      const currentHeight = panel.offsetHeight;

      if (currentWidth !== lastKnownSize.width || currentHeight !== lastKnownSize.height) {
        const isSignificantChange =
          Math.abs(currentWidth - lastKnownSize.width) > 10 ||
          Math.abs(currentHeight - lastKnownSize.height) > 10;

        if (userIsResizing || isSignificantChange) {
          if (currentWidth > 300) {
            storedPanelWidth = `${currentWidth}px`;
            storageHelper.set('panelWidth', storedPanelWidth);
          }
          if (currentHeight > 100) {
            storedPanelHeight = `${currentHeight}px`;
            storageHelper.set('panelHeight', storedPanelHeight);
          }
        }

        lastKnownSize.width = currentWidth;
        lastKnownSize.height = currentHeight;
      }
    }, 200);
  });
  resizeObserver.observe(panel);
  panel.hasResizeObserver = true;
}

export function applyPanelSize(panel) {
  panel._ignoreResize = true;

  if (!panel.hasMutationObserver) {
    const mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          panel._ignoreResize = true;

          setTimeout(() => {
            panel._ignoreResize = false;
          }, 500);
        }
      });
    });

    mutationObserver.observe(panel, {
      attributes: true,
      attributeFilter: ['style'],
    });
    panel.hasMutationObserver = true;
  }

  if (!storedPanelWidth) {
    const hasModelA = !!getState('models.documentA');
    const hasModelB = !!getState('models.documentB');
    const isSingleModel = (hasModelA && !hasModelB) || (!hasModelA && hasModelB);

    if (isSingleModel) {
      storedPanelWidth = '25vw';
    } else {
      storedPanelWidth = '30vw';
    }
  }

  if (storedPanelWidth) {
    if (storedPanelWidth.endsWith('px')) {
      const widthValue = parseInt(storedPanelWidth);
      if (widthValue >= 300) {
        panel.style.width = storedPanelWidth;
      } else {
        panel.style.width = '300px';
        storedPanelWidth = '300px';
        storageHelper.set('panelWidth', storedPanelWidth);
      }
    } else {
      panel.style.width = storedPanelWidth;
    }
  }
  panel.style.minWidth = '300px';
  panel.style.maxWidth = '70vw';

  if (storedPanelHeight) {
    panel.style.height = storedPanelHeight;
  }

  setTimeout(() => {
    panel._ignoreResize = false;

    if (panel.hasResizeObserver) {
      panel.dispatchEvent(
        new CustomEvent('initializeSize', {
          detail: {
            width: panel.offsetWidth,
            height: panel.offsetHeight,
          },
        }),
      );
    }
  }, 600);
}

export function tryFallbackDisplay(elementType, idA, idB, contentDiv) {
  try {
    const scene = window?.viewer?.scene || window?.scene;
    if (!scene) return false;

    let targetMesh = null;
    scene.traverse((o) => {
      if (targetMesh) return;
      if (o.isMesh && o.userData && o.userData.elementType === elementType) {
        const eid = o.userData.elementId;
        if (eid && (eid === idA || eid === idB || (!idA && !idB))) {
          targetMesh = o;
        }
      }
    });

    if (targetMesh) {
      const ud = targetMesh.userData || {};
      const sec = ud.sectionDataOriginal || ud.beamData?.section || ud.columnData?.section || {};
      const dims = sec.dimensions || sec;
      const dimPairs = Object.entries(dims)
        .filter(
          ([_k, v]) =>
            typeof v === 'number' || (typeof v === 'string' && v.match(/^\d+(?:\.\d+)?$/)),
        )
        .map(([key, v]) => `${escapeHtml(key)}: ${escapeHtml(v)}`)
        .slice(0, 24)
        .join('<br>');
      const metaPairs = Object.entries(ud.profileMeta || {})
        .map(([key, v]) => `${escapeHtml(key)}: ${escapeHtml(v)}`)
        .join('<br>');
      const derivedHtml = `
        <div style="font-weight:var(--font-weight-bold);margin-bottom:4px;">${escapeHtml(elementType)} (Mesh UserData)</div>
        <div><strong>ID:</strong> ${valueToSafeHtml(ud.elementId, '-')}</div>
        <div><strong>Section Type:</strong> ${valueToSafeHtml(
          ud.sectionType || ud.profileMeta?.sectionTypeResolved,
          '-',
        )}</div>
        <div><strong>Profile Source:</strong> ${valueToSafeHtml(ud.profileMeta?.profileSource, '-')}</div>
        <div style="margin-top:6px;"><strong>Dimensions (from enriched section):</strong><br>${
          dimPairs || '-'
        }</div>
        <div style="margin-top:6px;"><strong>Profile Meta:</strong><br>${metaPairs || '-'}</div>
        <div style="margin-top:6px;"><strong>Raw shapeName:</strong> ${valueToSafeHtml(
          sec.shapeName || ud.shapeName,
          '-',
        )}</div>
      `;
      contentDiv.innerHTML = renderElementInfoTabs({
        stbHtml: '<div class="element-info-tab-empty">STB XML情報は利用できません。</div>',
        derivedHtml,
        preferredTab: 'derived',
      });
      setupElementInfoTabs(contentDiv);

      return true;
    }
  } catch (e) {
    logger.warn('Fallback element info display failed:', e);
  }
  return false;
}

function renderJointParentRow(label, valueA, valueB, showSingleColumn, parentRowId) {
  const attrIndentStyle = 'padding-left: 2.25em;';
  let html = `<tr data-parent="${parentRowId}">`;
  html += `<td style="${attrIndentStyle}"><span class="attr-name">${label}</span></td>`;

  if (showSingleColumn) {
    const value = valueA !== '-' ? valueA : valueB;
    html += `<td>${escapeHtml(value)}</td>`;
  } else {
    const isDiff = valueA !== valueB;
    const highlightClass = isDiff ? ' class="differs"' : '';
    html += `<td${highlightClass}>${escapeHtml(valueA)}</td>`;
    html += `<td${highlightClass}>${escapeHtml(valueB)}</td>`;
  }

  html += '</tr>';
  return html;
}

function renderJointParentInfo(jointMeshDataA, jointMeshDataB, showSingleColumn, _modelSource) {
  const jdA = jointMeshDataA?.jointData || {};
  const jdB = jointMeshDataB?.jointData || {};

  if (!jdA.parent_element_type && !jdB.parent_element_type) {
    return '';
  }

  let html = '';
  const rowId = `row_parent_info_${Math.random().toString(36).slice(2, 7)}`;

  html += `<tr class="element-row" data-id="${rowId}">`;
  html += '<td style="padding-left: 0; white-space: nowrap;">';
  html += `<span class="toggle-btn" data-target-id="${rowId}" style="margin-right:5px;display:inline-block;width:1em;text-align:center;font-weight:var(--font-weight-bold);cursor:pointer;color:#666;">-</span>`;
  html += '<span class="tag-name">親部材情報</span>';
  html += '</td>';
  if (showSingleColumn) {
    html += '<td></td>';
  } else {
    html += '<td></td><td></td>';
  }
  html += '</tr>';

  const parentTypeA = jdA.parent_element_type || '-';
  const parentTypeB = jdB.parent_element_type || '-';
  html += renderJointParentRow('親部材タイプ', parentTypeA, parentTypeB, showSingleColumn, rowId);

  const parentIdA = jdA.parent_element_id || jointMeshDataA?.elementId || '-';
  const parentIdB = jdB.parent_element_id || jointMeshDataB?.elementId || '-';
  html += renderJointParentRow('親部材ID', parentIdA, parentIdB, showSingleColumn, rowId);

  const posA =
    jointMeshDataA?.jointPosition === 'start'
      ? '始端'
      : jointMeshDataA?.jointPosition === 'end'
        ? '終端'
        : '-';
  const posB =
    jointMeshDataB?.jointPosition === 'start'
      ? '始端'
      : jointMeshDataB?.jointPosition === 'end'
        ? '終端'
        : '-';
  html += renderJointParentRow('配置位置', posA, posB, showSingleColumn, rowId);

  if (jdA.center || jdB.center) {
    const centerA = jdA.center
      ? `X: ${jdA.center.x?.toFixed(1) || '-'}, Y: ${jdA.center.y?.toFixed(1) || '-'}, Z: ${jdA.center.z?.toFixed(1) || '-'} mm`
      : '-';
    const centerB = jdB.center
      ? `X: ${jdB.center.x?.toFixed(1) || '-'}, Y: ${jdB.center.y?.toFixed(1) || '-'}, Z: ${jdB.center.z?.toFixed(1) || '-'} mm`
      : '-';
    html += renderJointParentRow('継手中心座標', centerA, centerB, showSingleColumn, rowId);
  }

  return html;
}

export function showJointMeshDataOnly(
  panel,
  title,
  contentDiv,
  jointMeshDataA,
  jointMeshDataB,
  modelSource = null,
) {
  const hasModelA = !!getState('models.documentA');
  const hasModelB = !!getState('models.documentB');
  const hasPrimaryA = !!jointMeshDataA;
  const hasPrimaryB = !!jointMeshDataB;
  const showSingleColumn = shouldUseSingleColumnElementInfo({
    hasPrimaryA,
    hasPrimaryB,
    hasModelA,
    hasModelB,
  });
  const displayModelSide = resolveElementInfoModelSide({
    hasPrimaryA,
    hasPrimaryB,
    modelSource,
    hasModelA,
    hasModelB,
  });

  const titleHtml = renderElementInfoTitleHtml(title);
  let derivedContent = '<table class="unified-comparison-table">';

  if (showSingleColumn) {
    derivedContent += buildSingleColumnHeaderHtml('属性', displayModelSide);
  } else {
    derivedContent += buildComparisonHeaderHtml('属性');
  }

  derivedContent += '<tbody>';
  derivedContent += renderJointParentInfo(jointMeshDataA, jointMeshDataB, showSingleColumn, null);
  derivedContent += '</tbody></table>';
  derivedContent +=
    '<p style="color: orange; font-size: var(--font-size-sm); margin-top: 8px;">※ XML内に継手定義が見つかりませんでした。メッシュデータのみを表示しています。</p>';

  contentDiv.innerHTML =
    titleHtml +
    renderElementInfoTabs({
      stbHtml: '<div class="element-info-tab-empty">STB XML内に継手定義が見つかりません。</div>',
      derivedHtml: derivedContent,
      preferredTab: 'derived',
    });
  setupElementInfoTabs(contentDiv);

  const tbody = contentDiv.querySelector('tbody');
  if (tbody) {
    setupCollapseHandlers(tbody);
  }

  let style = panel.querySelector('style#element-info-styles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'element-info-styles';
    panel.appendChild(style);
  }
  style.textContent = generateTableStyles(showSingleColumn);
}

export function showInfo(
  nodeA,
  nodeB,
  panel,
  title,
  contentDiv,
  modelSource = null,
  elementType = null,
  jointMeshDataA = null,
  jointMeshDataB = null,
  findSectionTagNameById,
) {
  if (!panel || !contentDiv) {
    logger.error('Panel or contentDiv is missing in showInfo');
    return;
  }

  const idA = nodeA ? nodeA.getAttribute('id') : null;
  const idB = nodeB ? nodeB.getAttribute('id') : null;

  const titleHtml = renderElementInfoTitleHtml(title);
  let content = '';

  const hasModelA = !!getState('models.documentA');
  const hasModelB = !!getState('models.documentB');
  const hasPrimaryA = !!nodeA;
  const hasPrimaryB = !!nodeB;
  const showSingleColumn = shouldUseSingleColumnElementInfo({
    hasPrimaryA,
    hasPrimaryB,
    hasModelA,
    hasModelB,
  });
  const displayModelSide = resolveElementInfoModelSide({
    hasPrimaryA,
    hasPrimaryB,
    modelSource,
    hasModelA,
    hasModelB,
  });

  content += '<table class="unified-comparison-table">';

  if (showSingleColumn) {
    content += buildSingleColumnHeaderHtml('要素 / 属性', displayModelSide);
  } else {
    content += buildComparisonHeaderHtml('要素 / 属性');
  }

  content += `<tbody id="element-info-tbody">`;

  content += renderComparisonRecursive(
    nodeA,
    nodeB,
    0,
    'root',
    showSingleColumn,
    modelSource,
    elementType,
  );

  content += renderSectionInfo(nodeA, nodeB, showSingleColumn, modelSource, elementType);

  if (elementType === 'Wall' || elementType === 'ShearWall' || elementType === 'Slab') {
    content += renderOpeningInfo(nodeA, nodeB, showSingleColumn);
  }

  if (jointMeshDataA || jointMeshDataB) {
    content += renderJointParentInfo(jointMeshDataA, jointMeshDataB, showSingleColumn, modelSource);
  }

  content += '</tbody></table>';

  const editingState = getState('models.editing');
  const suppressAReason =
    editingState?.active &&
    (editingState.dirty || editingState.untrackedDirty || Number(editingState.workingRevision) > 0)
      ? '編集中のモデルA数量は増分再計算未対応のため、stale値を表示していません。'
      : null;
  const derivedContent = renderQuantityInfoFromStores({
    storeA: getState('models.derivedQuantitiesA'),
    storeB: getState('models.derivedQuantitiesB'),
    nodeA,
    nodeB,
    showSingleColumn,
    displayModelSide,
    suppressAReason,
  });

  const elementId = idA || idB;
  const displayedValidationIds = new Set();
  const elementTagName = nodeA?.tagName || nodeB?.tagName || '';
  if (elementId) {
    const validationHtml = generateValidationInfoHtml(elementId, {
      targetElementName: elementTagName || undefined,
    });
    if (validationHtml) {
      content += validationHtml;
      displayedValidationIds.add(`${elementId}:${elementTagName || '*'}`);
    }
  }

  const sectionIdA = nodeA?.getAttribute('id_section');
  const sectionIdB = nodeB?.getAttribute('id_section');
  const sectionIds = [...new Set([sectionIdA, sectionIdB].filter(Boolean))];
  for (const sectionId of sectionIds) {
    const sectionTags = new Set();
    if (sectionId === sectionIdA) {
      const tagA = findSectionTagNameById(nodeA?.ownerDocument, sectionId);
      if (tagA) sectionTags.add(tagA);
    }
    if (sectionId === sectionIdB) {
      const tagB = findSectionTagNameById(nodeB?.ownerDocument, sectionId);
      if (tagB) sectionTags.add(tagB);
    }

    if (sectionTags.size === 0) {
      const fallbackKey = `${sectionId}:*`;
      if (!displayedValidationIds.has(fallbackKey)) {
        const sectionValidationHtml = generateValidationInfoHtml(sectionId);
        if (sectionValidationHtml) {
          content += sectionValidationHtml;
          displayedValidationIds.add(fallbackKey);
        }
      }
      continue;
    }

    for (const sectionTag of sectionTags) {
      const sectionDisplayKey = `${sectionId}:${sectionTag}`;
      if (displayedValidationIds.has(sectionDisplayKey)) continue;

      const sectionValidationHtml = generateValidationInfoHtml(sectionId, {
        contextTagName: sectionTag,
        contextId: sectionId,
      });
      if (sectionValidationHtml) {
        content += sectionValidationHtml;
        displayedValidationIds.add(sectionDisplayKey);
      }
    }
  }

  contentDiv.innerHTML =
    titleHtml +
    renderElementInfoTabs({
      stbHtml: content,
      derivedHtml: derivedContent,
    });
  setupElementInfoTabs(contentDiv);

  const tbody = contentDiv.querySelector('#element-info-tbody');
  setupCollapseHandlers(tbody);

  let style = panel.querySelector('style#element-info-styles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'element-info-styles';
    panel.appendChild(style);
  }
  style.textContent = generateTableStyles(showSingleColumn);
}

export function displayMultiSelectionSummary(summaryData = {}) {
  const panel = document.getElementById('component-info');
  const contentDiv = document.getElementById('element-info-content');

  clearElementInfoDisplayState(contentDiv, { renderEmptyMessage: false });

  if (!panel || !contentDiv) {
    logger.error('Component info panel or content div not found!');
    return;
  }

  applyPanelSize(panel);
  setupPanelResizeObserver(panel);

  const { count = 0, typeCounts = [], modelSourceCounts: rawModelSourceCounts = {} } = summaryData;
  const modelSourceCounts = {
    A: rawModelSourceCounts.A ?? 0,
    B: rawModelSourceCounts.B ?? 0,
    matched: rawModelSourceCounts.matched ?? 0,
    unknown: rawModelSourceCounts.unknown ?? 0,
  };

  let summaryHtml = `
    <div style="font-weight:var(--font-weight-bold);margin-bottom:8px;font-size:var(--font-size-lg);">
      複数選択: ${count}要素
    </div>
    <div style="margin-bottom:8px;">
      <strong>要素タイプ:</strong>
      <ul style="margin:4px 0;padding-left:20px;">
  `;

  for (const item of typeCounts) {
    summaryHtml += `<li>${escapeHtml(item.elementType)}: ${escapeHtml(item.count)}</li>`;
  }

  summaryHtml += `
      </ul>
    </div>
    <div>
      <strong>モデルソース:</strong>
      <ul style="margin:4px 0;padding-left:20px;">
  `;

  if (modelSourceCounts.A > 0) summaryHtml += `<li>モデルA: ${modelSourceCounts.A}</li>`;
  if (modelSourceCounts.B > 0) summaryHtml += `<li>モデルB: ${modelSourceCounts.B}</li>`;
  if (modelSourceCounts.matched > 0)
    summaryHtml += `<li>マッチ済: ${modelSourceCounts.matched}</li>`;
  if (modelSourceCounts.unknown > 0) summaryHtml += `<li>不明: ${modelSourceCounts.unknown}</li>`;

  summaryHtml += `
      </ul>
    </div>
  `;

  contentDiv.innerHTML = summaryHtml;
}
