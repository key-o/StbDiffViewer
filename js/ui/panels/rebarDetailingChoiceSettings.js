/**
 * @fileoverview 鉄筋生成設定ウィンドウ内の配筋納まり設定UI。
 *
 * 付録Aから分離した選択軸を project common config に保存する。
 * hard constraint のON/OFF UIは提供せず、選択可能な detailing policy のみを扱う。
 */

import {
  getRebarCommonConfig,
  loadRebarCommonConfig,
  setRebarCommonConfig,
} from '../../config/rebarCommonConfig.js';
import {
  DEFAULT_REBAR_DETAILING_CHOICE,
  REBAR_DETAILING_CHOICE_UI_OPTIONS,
  normalizeRebarDetailingChoice,
  resolveRebarDetailingChoiceControlState,
} from '../../config/rebarDetailingChoice.js';

const SETTINGS_ID = 'rebar-detailing-choice-settings';
const JOINT_HOOP_PW_FALLBACK_OPTIONS = Object.freeze([
  { value: '', label: '未指定（構造図・STB情報を要求）', selectable: true },
  { value: '0.002', label: 'pw = 0.2%（柱一般部から径を自動選定）', selectable: true },
  { value: '0.003', label: 'pw = 0.3%（柱一般部から径を自動選定）', selectable: true },
]);
let storageLoadAttempted = false;
let widthCheckProvider = null;
let jointAssemblyCheckProvider = null;

export function setRebarDetailingWidthCheckProvider(provider) {
  widthCheckProvider = typeof provider === 'function' ? provider : null;
}

export function setRebarDetailingJointAssemblyCheckProvider(provider) {
  jointAssemblyCheckProvider = typeof provider === 'function' ? provider : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadPersistedConfigOnce() {
  if (storageLoadAttempted) return;
  storageLoadAttempted = true;
  loadRebarCommonConfig();
}

function createOption(option, currentValue, context = {}) {
  const element = document.createElement('option');
  element.value = option.value;
  const geometrySuffix =
    option.geometrySupported === false
      ? '（判定のみ・3D未接続）'
      : option.geometrySupported === 'EXPLICIT'
        ? '（明示pairing指定時のみ3D）'
        : '';
  element.textContent = option.label + geometrySuffix;
  const memberAllowed =
    !Array.isArray(option.memberTypes) || option.memberTypes.includes(context.memberType);
  element.disabled = option.selectable === false || !memberAllowed;
  element.selected = option.value === currentValue;
  return element;
}

function createSelect(options, value, title, context = {}) {
  const select = document.createElement('select');
  select.className = 'form-control';
  select.title = title;
  options.forEach((option) => select.appendChild(createOption(option, value, context)));
  return select;
}

function createRow(label, control, note = '') {
  const row = document.createElement('tr');
  const labelCell = document.createElement('td');
  labelCell.textContent = label;
  const controlCell = document.createElement('td');
  controlCell.colSpan = 5;
  controlCell.appendChild(control);
  if (note) {
    const help = document.createElement('div');
    help.className = 'color-setting-help';
    help.textContent = note;
    controlCell.appendChild(help);
  }
  row.append(labelCell, controlCell);
  return row;
}

function createSectionRow(label) {
  const row = document.createElement('tr');
  row.className = 'element-group-row';
  const cell = document.createElement('td');
  cell.colSpan = 6;
  const strong = document.createElement('strong');
  strong.textContent = label;
  cell.appendChild(strong);
  row.appendChild(cell);
  return row;
}

function dispatchChoiceChanged(choice) {
  const EventCtor = document.defaultView?.CustomEvent || globalThis.CustomEvent;
  if (typeof EventCtor !== 'function') return;
  document.dispatchEvent(
    new EventCtor('rebar-detailing-choice-changed', {
      detail: { choice: clone(choice) },
    }),
  );
}

function saveChoice(choice, statusNode) {
  const result = setRebarCommonConfig({ detailing: { choice } });
  if (!result.ok) {
    statusNode.textContent = `設定エラー: ${result.errors.join(' / ')}`;
    statusNode.dataset.status = 'error';
    return false;
  }
  statusNode.textContent = '保存済み。表示中の鉄筋は次回再生成時に反映します。';
  statusNode.dataset.status = 'saved';
  dispatchChoiceChanged(result.config.detailing.choice);
  return true;
}

function saveColumnJointHoopFallbackPwRatio(rawValue, statusNode) {
  const fallbackPwRatio = rawValue === '' ? null : Number(rawValue);
  const result = setRebarCommonConfig({
    column: { hoopPlacementRule: { fallbackPwRatio } },
  });
  if (!result.ok) {
    statusNode.textContent = `設定エラー: ${result.errors.join(' / ')}`;
    statusNode.dataset.status = 'error';
    return false;
  }
  statusNode.textContent = '保存済み。表示中の鉄筋は次回再生成時に反映します。';
  statusNode.dataset.status = 'saved';
  dispatchChoiceChanged(result.config.detailing.choice);
  return true;
}

function supportMessage(choice, memberType) {
  const support = resolveRebarDetailingChoiceControlState(choice, memberType).geometrySupport;
  if (support.supported) {
    const closure = support.geometry?.closureType === 'WELDED' ? '溶接閉鎖' : '135°フック閉鎖';
    return `現行R11接続: ${closure}`;
  }
  return `現行R11未接続: ${support.reason}`;
}

function buildMemberRows(
  tbody,
  choice,
  key,
  memberType,
  labelPrefix,
  statusNode,
  legacyOverride = false,
) {
  const memberChoice = choice[key];
  const closure = createSelect(
    REBAR_DETAILING_CHOICE_UI_OPTIONS.closureFamily,
    memberChoice.closureFamily,
    `${labelPrefix}の閉鎖方式`,
    { memberType },
  );
  const pattern = createSelect(
    REBAR_DETAILING_CHOICE_UI_OPTIONS.hookPattern,
    memberChoice.hookPattern,
    `${labelPrefix}のフック配置`,
    { memberType },
  );
  const fabrication = createSelect(
    REBAR_DETAILING_CHOICE_UI_OPTIONS.fabricationSequence,
    memberChoice.fabricationSequence,
    `${labelPrefix}の加工方法`,
  );
  const support = document.createElement('span');

  const applyDependencyState = () => {
    const state = resolveRebarDetailingChoiceControlState(choice, memberType);
    closure.disabled = legacyOverride;
    pattern.disabled = legacyOverride || state.hookPatternDisabled;
    fabrication.disabled = legacyOverride || state.fabricationSequenceDisabled;
    support.textContent = legacyOverride
      ? 'legacy project hook rule が優先中（canonical choice UIは編集不可）'
      : supportMessage(choice, memberType);
  };

  const update = (field, value) => {
    if (legacyOverride) return;
    choice[key][field] = value;
    if (saveChoice(choice, statusNode)) applyDependencyState();
  };

  closure.addEventListener('change', () => update('closureFamily', closure.value));
  pattern.addEventListener('change', () => update('hookPattern', pattern.value));
  fabrication.addEventListener('change', () => update('fabricationSequence', fabrication.value));

  tbody.appendChild(createSectionRow(labelPrefix));
  tbody.appendChild(
    createRow(
      '閉鎖方式',
      closure,
      '既知の付録A選択肢は設定可能。3D未接続形状はSPECIAL_REQUIREDとしてfail-closed。',
    ),
  );
  tbody.appendChild(
    createRow(
      'フック配置',
      pattern,
      'フック閉鎖時のみ有効。片隅も判定条件として選択可能だが現行R11 geometryは未接続。',
    ),
  );
  tbody.appendChild(
    createRow('加工方法', fabrication, '完成形状とは別責務。フック後曲げも完成時135°として扱う。'),
  );
  tbody.appendChild(createRow('接続状態', support));
  applyDependencyState();
}

function buildChoiceTable(choice, statusNode, legacyOverrides = {}, commonConfig = {}) {
  const table = document.createElement('table');
  table.className = 'element-settings-table';
  const tbody = document.createElement('tbody');

  tbody.appendChild(createSectionRow('配筋標準'));
  const profile = createSelect(
    REBAR_DETAILING_CHOICE_UI_OPTIONS.profile,
    choice.profile,
    '配筋標準納まり',
  );
  profile.addEventListener('change', () => {
    choice.profile = profile.value;
    saveChoice(choice, statusNode);
  });
  tbody.appendChild(
    createRow(
      '標準納まり',
      profile,
      '選択ルールとA2/A3判定の基準プロファイル。hard constraintの無効化には使用しません。',
    ),
  );

  buildMemberRows(
    tbody,
    choice,
    'columnHoop',
    'column',
    '柱 帯筋',
    statusNode,
    legacyOverrides.columnHoop === true,
  );
  buildMemberRows(
    tbody,
    choice,
    'girderStirrup',
    'beam',
    '梁 あばら筋',
    statusNode,
    legacyOverrides.girderStirrup === true,
  );

  tbody.appendChild(createSectionRow('柱梁接合部'));
  const assembly = createSelect(
    REBAR_DETAILING_CHOICE_UI_OPTIONS.orthogonalBeamAssemblyOrder,
    choice.joint.orthogonalBeamAssemblyOrder,
    '直交梁の組立順',
  );
  assembly.addEventListener('change', () => {
    choice.joint.orthogonalBeamAssemblyOrder = assembly.value;
    saveChoice(choice, statusNode);
  });
  tbody.appendChild(
    createRow(
      '直交梁組立順',
      assembly,
      '付録Aの例を一律defaultにせず、未指定時は図面指定必須として保持。',
    ),
  );

  const cornerAnchorage = createSelect(
    REBAR_DETAILING_CHOICE_UI_OPTIONS.cornerAnchorageMethod,
    choice.joint.cornerAnchorageMethod,
    '隅柱梁接合部の梁主筋定着方法',
  );
  cornerAnchorage.addEventListener('change', () => {
    choice.joint.cornerAnchorageMethod = cornerAnchorage.value;
    saveChoice(choice, statusNode);
  });
  tbody.appendChild(
    createRow(
      '隅柱梁の定着',
      cornerAnchorage,
      '付録Aの基本候補を「抱え込み定着」「U字形定着」として独立選択。抱え込みは4d actual path接続済み。U字形は個別bar pairing・投影位置・内法径のproject明示指定がある場合のみ3D生成。',
    ),
  );

  const cornerCongestion = createSelect(
    REBAR_DETAILING_CHOICE_UI_OPTIONS.cornerCongestionMethod,
    choice.joint.cornerCongestionMethod,
    '隅柱梁接合部の混雑緩和方法',
  );
  cornerCongestion.addEventListener('change', () => {
    choice.joint.cornerCongestionMethod = cornerCongestion.value;
    saveChoice(choice, statusNode);
  });
  tbody.appendChild(
    createRow(
      '隅柱梁の混雑緩和',
      cornerCongestion,
      '「梁突出し法」「梁内寄せ法」を定着方法とは別責務で保持。寸法は標準図から推定せず、project explicit geometryを検証してsidecar化。Working Documentの部材geometryはまだ自動変更しません。',
    ),
  );

  const hoopConstruction = createSelect(
    REBAR_DETAILING_CHOICE_UI_OPTIONS.hoopConstructionMethod,
    choice.joint.hoopConstructionMethod,
    '仕口部帯筋の施工方法',
  );
  hoopConstruction.addEventListener('change', () => {
    choice.joint.hoopConstructionMethod = hoopConstruction.value;
    saveChoice(choice, statusNode);
  });
  tbody.appendChild(
    createRow(
      '仕口部帯筋施工',
      hoopConstruction,
      '落とし込み・現場組立・アコーディオン方式を施工方法として分離。帯筋形状の選択とは独立。',
    ),
  );

  const configuredPw = Number(commonConfig.column?.hoopPlacementRule?.fallbackPwRatio);
  const fallbackPw = createSelect(
    JOINT_HOOP_PW_FALLBACK_OPTIONS,
    [0.002, 0.003].includes(configuredPw) ? String(configuredPw) : '',
    '仕口部Hoop筋のpwフォールバック',
  );
  fallbackPw.addEventListener('change', () => {
    saveColumnJointHoopFallbackPwRatio(fallbackPw.value, statusNode);
  });
  tbody.appendChild(
    createRow(
      '仕口部 Hoop pw',
      fallbackPw,
      'STB・構造図相当の仕口帯筋指定が無い場合だけ使用。柱一般部のprimary Hoopピッチと3D脚数を継承し、pwX=Nx×Ab/(Dy×s)、pwY=Ny×Ab/(Dx×s)を満たすD10～D41の最小径を選定します。一般部Hoop径未満にはしません。',
    ),
  );

  tbody.appendChild(createSectionRow('主筋連続性'));
  const columnCornerLabel = document.createElement('label');
  const columnCorner = document.createElement('input');
  columnCorner.type = 'checkbox';
  columnCorner.checked = choice.continuity.columnCornerPriority === true;
  columnCornerLabel.append(
    columnCorner,
    document.createTextNode(' 柱四隅主筋を辺中央筋より優先して連続'),
  );
  columnCorner.addEventListener('change', () => {
    choice.continuity.columnCornerPriority = columnCorner.checked;
    saveChoice(choice, statusNode);
  });
  tbody.appendChild(
    createRow(
      '柱 四隅主筋優先',
      columnCornerLabel,
      'EXPERT_ACCEPTED / L2。Phase 3 column priority resolverへproject opt-inとして接続。hard constraintを上書きしません。',
    ),
  );

  const girderCornerLabel = document.createElement('label');
  const girderCorner = document.createElement('input');
  girderCorner.type = 'checkbox';
  girderCorner.checked = choice.continuity.girderCornerPriority === true;
  girderCornerLabel.append(
    girderCorner,
    document.createTextNode(' 梁1段目の左右端主筋を同一role/layerの中間筋より優先して連続'),
  );
  girderCorner.addEventListener('change', () => {
    choice.continuity.girderCornerPriority = girderCorner.checked;
    saveChoice(choice, statusNode);
  });
  tbody.appendChild(
    createRow(
      '梁 コーナー主筋優先',
      girderCornerLabel,
      'EXPERT_ACCEPTED / L2。Phase 5a girder priority resolverへproject opt-inとして接続。world-straight-firstとhard constraintを優先します。',
    ),
  );

  table.appendChild(tbody);
  return table;
}

function classifyWidthCheck(check) {
  if (!check?.ok || check.status === 'UNRESOLVED') return 'UNRESOLVED';
  if (['FAIL', 'FAIL_ALL'].includes(check.status)) return 'FAIL';
  if (check.status === 'CONDITIONAL') return 'CONDITIONAL';
  if (['PASS', 'PASS_ALL'].includes(check.status)) {
    if (
      check.exposureAssumed === true ||
      check.coverAssumed === true ||
      (check.warnings || []).length > 0
    ) {
      return 'INFO';
    }
    return 'PASS';
  }
  return 'INFO';
}

function formatWidthCheck(check) {
  const target = [
    check.sectionName || check.sectionId || '-',
    check.position,
    check.axis,
    check.side,
    check.layer ? `L${check.layer}` : null,
  ]
    .filter(Boolean)
    .join(' / ');
  const range = check.requiredWidthRangeMm
    ? check.requiredWidthRangeMm.min === check.requiredWidthRangeMm.max
      ? `必要幅 ${check.requiredWidthRangeMm.min}mm`
      : `必要幅 ${check.requiredWidthRangeMm.min}–${check.requiredWidthRangeMm.max}mm`
    : check.reason || '必要幅未解決';
  const provided = Number.isFinite(check.providedWidthMm)
    ? ` / 断面幅 ${check.providedWidthMm}mm`
    : '';
  return `${target}: ${check.status} / ${range}${provided}`;
}

function renderWidthCheckResults(container, result) {
  container.replaceChildren();
  const entries = [];
  for (const [modelSource, checks] of Object.entries(result || {})) {
    for (const check of checks || []) entries.push({ modelSource, check });
  }

  if (entries.length === 0) {
    container.textContent = 'A3判定対象のRC柱・RC梁断面がありません。';
    return;
  }

  const counts = { PASS: 0, CONDITIONAL: 0, FAIL: 0, UNRESOLVED: 0, INFO: 0 };
  entries.forEach(({ check }) => {
    counts[classifyWidthCheck(check)] += 1;
  });

  const summary = document.createElement('div');
  summary.className = 'rebar-detailing-width-summary';
  summary.textContent = `A3最小断面幅の目安: PASS ${counts.PASS} / 要確認 ${counts.INFO} / 条件付 ${counts.CONDITIONAL} / 目安不足 ${counts.FAIL} / 未解決 ${counts.UNRESOLVED}`;
  container.appendChild(summary);

  const priority = { FAIL: 0, CONDITIONAL: 1, UNRESOLVED: 2, INFO: 3, PASS: 4 };
  const notable = entries
    .filter(({ check }) => classifyWidthCheck(check) !== 'PASS')
    .sort((a, b) => priority[classifyWidthCheck(a.check)] - priority[classifyWidthCheck(b.check)])
    .slice(0, 12);

  if (notable.length === 0) return;
  const list = document.createElement('ul');
  list.className = 'rebar-detailing-width-result-list';
  for (const { modelSource, check } of notable) {
    const item = document.createElement('li');
    item.dataset.status = classifyWidthCheck(check).toLowerCase();
    item.textContent = `Model ${modelSource} / ${formatWidthCheck(check)}`;
    list.appendChild(item);
  }
  container.appendChild(list);
}

function renderJointAssemblyCheckResults(container, result) {
  container.replaceChildren();
  const entries = [];
  for (const [modelSource, checks] of Object.entries(result || {})) {
    for (const check of checks || []) entries.push({ modelSource, check });
  }

  if (entries.length === 0) {
    container.textContent = 'A2直交梁組立順の対象となるRC/SRC接合部がありません。';
    return;
  }

  const resolved = entries.filter(({ check }) => check.status === 'RESOLVED');
  const unresolved = entries.filter(({ check }) => check.status !== 'RESOLVED');
  const geometryChecked = entries.filter(({ check }) => check.geometryFeasibility);
  const geometryAction = geometryChecked.filter(
    ({ check }) => check.geometryFeasibility?.status === 'ACTION_REQUIRED',
  );
  const geometryUnresolved = geometryChecked.filter(
    ({ check }) => check.geometryFeasibility?.status === 'UNRESOLVED',
  );

  const summary = document.createElement('div');
  summary.className = 'rebar-detailing-width-summary';
  summary.textContent =
    `A2直交梁組立順: 指定済 ${resolved.length} / 未指定・未解決 ${unresolved.length}` +
    (geometryChecked.length > 0
      ? ` / 納まりgeometry: 要調整 ${geometryAction.length} / 未解決 ${geometryUnresolved.length}`
      : '');
  container.appendChild(summary);

  const notable = [...unresolved, ...resolved].slice(0, 12);
  const list = document.createElement('ul');
  list.className = 'rebar-detailing-width-result-list';
  for (const { modelSource, check } of notable) {
    const item = document.createElement('li');
    item.dataset.status = check.status === 'RESOLVED' ? 'pass' : 'unresolved';
    const order =
      check.status === 'RESOLVED'
        ? `${check.firstAxis} → ${check.secondAxis}`
        : check.reason || '組立順未解決';
    const beams = [
      ...(check.xBeams || []).map((beam) => beam.name || beam.id),
      ...(check.yBeams || []).map((beam) => beam.name || beam.id),
      ...(check.otherBeams || []).map((beam) => beam.name || beam.id),
      ...(check.viaBeams || []).map((beam) => beam.name || beam.id),
    ]
      .filter(Boolean)
      .join(', ');
    const topology = check.jointTopology?.kind ? ` / ${check.jointTopology.kind}` : '';
    const cornerChoices =
      check.jointTopology?.kind === 'CORNER' && check.projectJointChoices
        ? ` / 定着:${check.projectJointChoices.cornerAnchorageMethod} / 混雑:${check.projectJointChoices.cornerCongestionMethod}`
        : '';
    const geometry = check.geometryFeasibility
      ? ` / geometry:${check.geometryFeasibility.status}` +
        (check.geometryFeasibility.cornerHookInsertion?.status
          ? ` / 4d:${check.geometryFeasibility.cornerHookInsertion.status}`
          : '')
      : '';
    const congestionRequirements = check.productionChoices?.congestion?.requirements || null;
    const congestionRequirementNote =
      check.productionChoices?.congestion?.method === 'BEAM_PROJECTION' && congestionRequirements
        ? ` / 突出し補強:U筋D${congestionRequirements.supplementalUBarDiaMm || '-'}・縦D${congestionRequirements.endVerticalBarDiaMm || '-'}・柱定着約${congestionRequirements.supplementalUBarColumnAnchorageApproxDiaFactor || '-'}d・あばら筋@${congestionRequirements.protrudingZoneStirrupMaxSpacingMm || '-'}以下・末端${congestionRequirements.endReturnBendMinDiaFactor || '-'}d以上`
        : check.productionChoices?.congestion?.method === 'BEAM_INNER_SETBACK' &&
            congestionRequirements
          ? ` / 内寄せ条件:柱入隅整合・外側直交線折曲げ・偏心確認`
          : '';
    const stbRepresentationStatus =
      check.productionChoices?.congestion?.stbRepresentation?.status || null;
    const stbRepresentationNote = stbRepresentationStatus
      ? ` / STB表現:${stbRepresentationStatus}`
      : '';
    const production = check.productionChoices
      ? ` / production:${check.productionChoices.status}` +
        (check.productionChoices.anchorage?.status
          ? ` / 定着gate:${check.productionChoices.anchorage.status}`
          : '') +
        (check.productionChoices.congestion?.status
          ? ` / 混雑gate:${check.productionChoices.congestion.status}`
          : '') +
        congestionRequirementNote +
        stbRepresentationNote +
        (check.productionChoices.hoopConstruction?.status
          ? ` / 帯筋施工:${check.productionChoices.hoopConstruction.status}`
          : '')
      : '';
    if (
      check.status !== 'RESOLVED' ||
      ['ACTION_REQUIRED', 'UNRESOLVED'].includes(check.geometryFeasibility?.status) ||
      ['UNRESOLVED', 'PARTIAL'].includes(check.productionChoices?.status)
    ) {
      item.dataset.status = 'unresolved';
    }
    item.textContent =
      `Model ${modelSource} / Node ${check.nodeId}: ${check.status} / ${order}` +
      topology +
      cornerChoices +
      geometry +
      production +
      (beams ? ` / ${beams}` : '');
    list.appendChild(item);
  }
  container.appendChild(list);
}

function buildJointAssemblyCheckControls() {
  const wrapper = document.createElement('div');
  wrapper.className = 'rebar-detailing-width-check';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm';
  button.textContent = 'A2 直交梁組立順をチェック';
  button.disabled = !jointAssemblyCheckProvider;

  const note = document.createElement('div');
  note.className = 'color-setting-help';
  note.textContent =
    '直交するRC/SRC梁のX/Y組立順を確認し、側柱・隅柱ではactual bar factsから外側梁筋の内寄せ干渉と4d挿入空間も検査します。geometryは判定のみで自動変更しません。';

  const results = document.createElement('div');
  results.className = 'rebar-detailing-joint-results';

  button.addEventListener('click', () => {
    if (!jointAssemblyCheckProvider) {
      results.textContent = 'A2判定プロバイダが未初期化です。';
      return;
    }
    try {
      renderJointAssemblyCheckResults(results, jointAssemblyCheckProvider());
    } catch (error) {
      results.textContent = `A2直交梁組立順チェックに失敗しました: ${error?.message || error}`;
      results.dataset.status = 'error';
    }
  });

  wrapper.append(button, note, results);
  return wrapper;
}

function buildWidthCheckControls() {
  const wrapper = document.createElement('div');
  wrapper.className = 'rebar-detailing-width-check';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm';
  button.textContent = 'A3 断面幅をチェック';
  button.disabled = !widthCheckProvider;

  const note = document.createElement('div');
  note.className = 'color-setting-help';
  note.textContent =
    'STB断面の主筋径・1列本数・帯筋/あばら筋径と付表A3-2の最小幅の目安を照合します。環境条件未指定時は標準非土接触として判定します。';

  const results = document.createElement('div');
  results.className = 'rebar-detailing-width-results';

  button.addEventListener('click', () => {
    if (!widthCheckProvider) {
      results.textContent = 'A3判定プロバイダが未初期化です。';
      return;
    }
    try {
      renderWidthCheckResults(results, widthCheckProvider());
    } catch (error) {
      results.textContent = `A3断面幅チェックに失敗しました: ${error?.message || error}`;
      results.dataset.status = 'error';
    }
  });

  wrapper.append(button, note, results);
  return wrapper;
}

/**
 * 鉄筋生成設定ウィンドウの専用領域に配筋納まり設定を追加する。
 */
export function renderRebarDetailingChoiceSettings() {
  if (document.getElementById(SETTINGS_ID)) return document.getElementById(SETTINGS_ID);
  const host = document.getElementById('rebar-detailing-choice-settings-host');
  if (!host) return null;

  loadPersistedConfigOnce();
  const config = getRebarCommonConfig();
  const choice = normalizeRebarDetailingChoice(config.detailing?.choice);
  const legacyOverrides = {
    columnHoop: Boolean(config.column?.hoopHookRule),
    girderStirrup: Boolean(config.girder?.stirrupHookRule),
  };

  const details = document.createElement('details');
  details.id = SETTINGS_ID;
  details.className = 'rebar-detailing-choice-settings';

  const summary = document.createElement('summary');
  summary.textContent = '配筋納まり・生成ルール';
  summary.title = '付録Aベースの選択可能な配筋ルールを設定';

  const description = document.createElement('p');
  description.className = 'color-setting-help';
  description.textContent =
    '選択可能な detailing policy のみを設定します。かぶり・あき・曲げ内法径・定着長等の hard constraint は常時有効です。';

  const status = document.createElement('div');
  status.className = 'color-setting-help';
  status.dataset.status = 'ready';
  status.textContent = '現在の設定を表示しています。';

  const table = buildChoiceTable(choice, status, legacyOverrides, config);
  const jointAssemblyCheck = buildJointAssemblyCheckControls();
  const widthCheck = buildWidthCheckControls();
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn btn-sm';
  reset.textContent = '暫定標準へ戻す';
  reset.addEventListener('click', () => {
    if (!saveChoice(clone(DEFAULT_REBAR_DETAILING_CHOICE), status)) return;
    details.remove();
    renderRebarDetailingChoiceSettings();
  });

  details.append(summary, description, table, jointAssemblyCheck, widthCheck, reset, status);
  host.appendChild(details);
  return details;
}
