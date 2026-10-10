/**
 * RC柱断面リストのHTML/DXF共通表示モデル。
 * 文字列の意味をここで決め、renderer/exporterは配置だけを担当する。
 */

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&times;/g, '×')
    .trim();
}

export function getColumnSectionListSectionName(sectionData) {
  return String(sectionData?.symbolNames || '');
}

export function getColumnSectionListArrangementEntries(presenter, sectionData) {
  const arrangements = presenter.getArrangements(sectionData);
  const totals = arrangements.reduce((result, arrangement) => {
    result[arrangement.position] = (result[arrangement.position] || 0) + 1;
    return result;
  }, {});
  const indexes = {};

  return arrangements.map((arrangement) => {
    indexes[arrangement.position] = (indexes[arrangement.position] || 0) + 1;
    return {
      arrangement,
      positionLabel: presenter.getPositionLabel(
        arrangement.position,
        indexes[arrangement.position],
        totals[arrangement.position],
      ),
    };
  });
}

export function getColumnSectionListSpecRows(presenter) {
  const rows = [
    {
      key: 'dimensions',
      label: 'B×D / Fc',
      value: (sectionData) => {
        const dimText = presenter.formatDimensions(sectionData);
        const concreteStrength = sectionData.concrete?.strength;
        return `${dimText} / ${concreteStrength ? presenter.escapeHtml(concreteStrength) : '—'}`;
      },
    },
    {
      key: 'mainBar',
      label: '主筋',
      value: (sectionData, arrangement) => presenter.formatMainBar(sectionData, arrangement),
    },
    {
      key: 'mainGrade',
      label: '主筋材料',
      value: (_sectionData, arrangement) => presenter.formatMainGrade(arrangement.mainBar),
    },
    {
      key: 'dt',
      label: '1段目dt',
      value: (sectionData, arrangement) => presenter.formatDt(sectionData, arrangement) || '—',
    },
  ];

  if (presenter.options?.showCoreBar !== false) {
    rows.push({
      key: 'coreBar',
      label: '芯鉄筋',
      value: (sectionData, arrangement) =>
        arrangement.coreBar ? presenter.formatCoreBar(sectionData, arrangement) : '—',
    });
  }

  rows.push({
    key: 'hoop',
    label: '帯筋',
    value: (sectionData, arrangement) => presenter.formatHoop(sectionData, arrangement),
  });

  return rows;
}

export function getColumnSectionListPlainTextRows(presenter) {
  return getColumnSectionListSpecRows(presenter).map((row) => ({
    ...row,
    value: (sectionData, arrangement) => stripHtml(row.value(sectionData, arrangement)),
  }));
}
