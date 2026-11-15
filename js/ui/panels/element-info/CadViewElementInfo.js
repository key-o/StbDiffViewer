/**
 * Read-only CAD selection information for the shared element info panel.
 * ViewSpec is owned by DrawingDocument; paper layout belongs to its placement.
 * Never alter DrawingProject or infer a view from the current 3D camera.
 */
import { setCurrentEditingElement } from './editMode/editState.js';
import { clearElementInfoTabHost } from './ElementInfoTabs.js';

const text = (value) => String(value ?? '—');
const mm = (value) => (value == null ? '—' : text(value) + ' mm');
const field = (name, value) => ({ name, value: text(value) });

// One selection context per document; DOM data-* attributes are diagnostic only.
const cadSelections = new WeakMap();

/** Pure projection of persisted records; a viewport never owns ViewSpec settings. */
export function resolveCadSelectionInfo(
  project,
  { viewId = '', sheetId = '', placementId = '' } = {},
) {
  if (!project) return null;
  const sheet = sheetId
    ? project.drawingSheets?.find((item) => item.id === sheetId && item.kind !== 'section-list')
    : null;
  if (sheetId && !sheet) return null;
  const placement = placementId ? sheet?.placements?.find((item) => item.id === placementId) : null;
  if (placementId && !placement) return null;
  if (placement && viewId && placement.drawingDocumentId !== viewId) return null;
  const resolvedViewId = placement?.drawingDocumentId || viewId;
  const view = resolvedViewId
    ? project.drawingDocuments?.find((item) => item.id === resolvedViewId)
    : null;
  if (resolvedViewId && !view) return null;
  if (!view && !sheet) return null;

  const sections = [];
  // The selected placement is the primary subject; a view definition is shared
  // by every sheet on which the view is placed.
  if (placement) {
    const offsetX = placement.viewOffsetXMm ?? 0;
    const offsetY = placement.viewOffsetYMm ?? 0;
    sections.push({
      heading: 'ビューポート配置（選択中・このシート固有）',
      properties: [
        field('参照ビュー', view?.name || view?.id),
        field('配置左上 X（用紙座標）', mm(placement.xMm)),
        field('配置左上 Y（用紙座標）', mm(placement.yMm)),
        field('枠幅（用紙座標）', mm(placement.widthMm)),
        field('枠高さ（用紙座標）', mm(placement.heightMm)),
        field('配置縮尺', '1/' + text(placement.scaleDenominator)),
        field('配置回転角', text(placement.rotationDeg) + '°'),
        field('表示位置補正 X（用紙）', mm(offsetX)),
        field('表示位置補正 Y（用紙）', mm(offsetY)),
        field('表示中心 X（用紙座標）', mm(placement.xMm + placement.widthMm / 2 + offsetX)),
        field('表示中心 Y（用紙座標）', mm(placement.yMm + placement.heightMm / 2 + offsetY)),
        field('座標基準', '用紙左上を原点・X右向き／Y下向き'),
        field('配置ID', placement.id),
      ],
    });
  }
  if (view) {
    const spec = view.view;
    sections.push({
      heading: 'ビュー定義（共通）',
      properties: [
        field('ビュー名', view.name || view.id),
        field('ビュー種類', spec.type === 'plan' ? '伏図' : '軸組図'),
        ...(spec.type === 'plan'
          ? [field('対象階 ID', spec.storyId)]
          : [
              field('通り方向', spec.axisDirection),
              field('通り芯 ID', spec.axisId),
              field('軸組図奥行（モデル座標）', mm(spec.depth)),
            ]),
        field(
          '総配置数',
          (project.drawingSheets ?? []).reduce(
            (sum, item) =>
              sum + (item.placements ?? []).filter((p) => p.drawingDocumentId === view.id).length,
            0,
          ),
        ),
        field('保存タグ数', view.tagIntents?.length ?? 0),
        field('保存寸法数', view.dimensionIntents?.length ?? 0),
      ],
    });

    const bounds = spec.cutBoundsMm;
    sections.push({
      heading: 'モデル切り出し（モデル座標 mm）',
      properties: bounds
        ? [
            field('X最小', mm(bounds.minX)),
            field('Y最小', mm(bounds.minY)),
            field('X最大', mm(bounds.maxX)),
            field('Y最大', mm(bounds.maxY)),
          ]
        : [field('切り出し範囲', '指定なし（標準のビュー範囲）')],
    });

    const display = view.display ?? {};
    const entries = (obj, label, render) =>
      Object.entries(obj ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => field(label + '：' + key, render(value)));
    sections.push({
      heading: 'ビュー表示設定（共通）',
      properties: [
        field('切断面の塗り', display.cutSurfaceFill === false ? '非表示' : '表示'),
        field('切断面の不透明度', display.cutSurfaceFillOpacity ?? 0.18),
        ...entries(display.visibility, '要素の表示', (value) => (value ? '表示' : '非表示')),
        ...entries(display.tagModes, 'タグ表示', (value) => text(value)),
        ...entries(display.colors, '要素色', (value) => text(value)),
      ],
    });

    const defaultSheet = view.sheet ?? {};
    sections.push({
      heading: 'ビューの初期出図設定（配置とは独立）',
      properties: [
        field('初期用紙', defaultSheet.paper || 'A3'),
        field('初期用紙方向', defaultSheet.orientation === 'portrait' ? '縦' : '横'),
        field('初期縮尺', '1/' + text(defaultSheet.scaleDenominator)),
        field('初期回転角', text(defaultSheet.rotationDeg ?? 0) + '°'),
        field('初期タグ向き', defaultSheet.tagOrientationMode ?? 'follow-member'),
      ],
    });

    const slot = project.modelSlots?.find((item) => item.id === view.modelSlotId);
    sections.push({
      heading: '参照元と識別子',
      properties: [
        field('ビューID', view.id),
        field('モデルスロット', view.modelSlotId),
        field('STB改訂 ID', view.sourceRevisionId),
        field(
          '改訂状態',
          !slot
            ? '参照モデルなし'
            : slot.currentRevisionId === view.sourceRevisionId
              ? '現行改訂と一致'
              : '現行改訂と不一致',
        ),
      ],
    });
  }
  if (sheet) {
    sections.push({
      heading: placement ? '配置先シート' : 'シート情報',
      properties: [
        field('シート番号', sheet.number),
        field('シート名', sheet.name),
        field('用紙', sheet.paper),
        field('用紙方向', sheet.orientation === 'landscape' ? '横' : '縦'),
        field('シートID', sheet.id),
      ],
    });
  }
  return {
    kind: placement ? 'viewport' : view ? 'view' : 'sheet',
    title: placement
      ? 'ビューポート：' + (view.name || view.id)
      : view
        ? 'ビュー：' + (view.name || view.id)
        : 'シート：' + sheet.number,
    selection: {
      viewId: resolvedViewId || '',
      sheetId: sheet?.id || '',
      placementId: placement?.id || '',
    },
    sections,
  };
}

/** All external names and IDs are inserted as text nodes, never innerHTML. */
function mountCadInfo(info, doc, owner = 'cad', projectId = null) {
  const root = doc?.getElementById('element-info-content');
  if (!root || !info) return false;
  const element = (tag, className = '', content = '') => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    node.textContent = content;
    return node;
  };
  const wrapper = element('article', 'cad-element-info');
  wrapper.append(element('h3', '', info.title));
  wrapper.append(
    element(
      'p',
      'cad-element-info-readonly',
      'CADプロパティ（表示のみ）。変更はビュー管理・シート配置から行います。',
    ),
  );
  const secondaryGroups = new Set([
    'ビュー表示設定（共通）',
    'ビューの初期出図設定（配置とは独立）',
    '参照元と識別子',
  ]);
  for (const section of info.sections) {
    const collapsible = secondaryGroups.has(section.heading);
    const sectionNode = element(collapsible ? 'details' : 'section', 'cad-element-info-section');
    sectionNode.append(element(collapsible ? 'summary' : 'h4', '', section.heading));
    const properties = element('dl', 'cad-element-info-properties');
    for (const property of section.properties) {
      properties.append(element('dt', '', property.name), element('dd', '', property.value));
    }
    sectionNode.append(properties);
    wrapper.append(sectionNode);
  }
  root.replaceChildren(wrapper);
  cadSelections.set(doc, { owner, selection: { ...info.selection }, projectId });
  root.dataset.infoOwner = owner;
  root.dataset.cadViewId = info.selection.viewId;
  root.dataset.cadSheetId = info.selection.sheetId;
  root.dataset.cadPlacementId = info.selection.placementId;
  clearElementInfoTabHost(doc.getElementById('element-info-tabs-host'));
  const exportButton = doc.getElementById('exportElementInfoJsonBtn');
  if (exportButton) exportButton.disabled = true;
  setCurrentEditingElement(null);
  return true;
}

export function displayCadSelectionInfo(project, selection, doc = globalThis.document) {
  return mountCadInfo(
    resolveCadSelectionInfo(project, selection),
    doc,
    'cad',
    project?.projectId ?? null,
  );
}

/** Current STB cut candidate is not a persisted DrawingDocument. */
export function displayCadCandidateInfo(
  candidate,
  { modelKey = 'A', depth = null, scaleDenominator = null } = {},
  doc = globalThis.document,
) {
  if (!candidate || !['plan', 'elevation'].includes(candidate.type)) return false;
  const properties = [
    field('登録状態', '未登録（現行STBからの切り出し候補）'),
    field('ビュー名', candidate.label || '名称未設定'),
    field('種類', candidate.type === 'plan' ? '伏図' : '軸組図'),
    ...(candidate.type === 'plan'
      ? [field('対象階 ID', candidate.storyId)]
      : [
          field('通り方向', candidate.axisDirection),
          field('通り芯 ID', candidate.axisId),
          field('奥行範囲', mm(depth)),
        ]),
    field('参照モデル', modelKey),
  ];
  if (scaleDenominator != null)
    properties.push(field('図面設定縮尺（画面ズームではない）', '1/' + text(scaleDenominator)));
  return mountCadInfo(
    {
      title: '現在のビュー：' + (candidate.label || '未登録'),
      selection: { viewId: '', sheetId: '', placementId: '' },
      sections: [{ heading: '一時ビュー（未登録）', properties }],
    },
    doc,
    'cad-candidate',
  );
}

export function refreshCadSelectionInfo(project, doc = globalThis.document) {
  const root = doc?.getElementById('element-info-content');
  if (root?.dataset.infoOwner !== 'cad') return false;
  const context = cadSelections.get(doc);
  if (!context || context.owner !== 'cad') return false;
  // Opening a different project must not resurrect a same-named stale view.
  if (context.projectId != null && context.projectId !== project?.projectId) {
    cadSelections.delete(doc);
    root.textContent = '別のプロジェクトが開かれました。表示対象を選択してください。';
    root.dataset.infoOwner = 'cad-stale';
    return false;
  }
  if (displayCadSelectionInfo(project, context.selection, doc)) return true;
  cadSelections.delete(doc);
  root.textContent =
    '選択対象が削除または変更されました。ビューまたはビューポートを選択してください。';
  root.dataset.cadViewId = '';
  root.dataset.cadSheetId = '';
  root.dataset.cadPlacementId = '';
  root.dataset.infoOwner = 'cad-stale';
  return false;
}
