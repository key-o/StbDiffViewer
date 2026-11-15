/**
 * Pure, lossless schedule projections for #526.  No positional aliases between
 * SHORT/LONG, MAIN/TRANSVERSE, X/Y or BASE/TIP are ever inferred.
 */

const DIRECTIONS = ['SHORT', 'LONG'];
const FACES = ['TOP', 'BOTTOM'];
const ZONES = ['END', 'CENTER'];

const display = (bar) => (bar && !bar.problems.length ? `${bar.rawD}@${bar.rawPitch}` : null);

function makeCell(positions, selectedBars, { reason = null } = {}) {
  if (!positions.length)
    return { status: 'NOT_APPLICABLE', display: null, sourcePositions: [], reason };
  if (selectedBars.length !== positions.length) {
    return {
      status: 'MISSING',
      display: null,
      sourcePositions: positions,
      reason: 'SOURCE_MISSING',
    };
  }
  if (selectedBars.some((bar) => bar.problems.length)) {
    return {
      status: 'INVALID',
      display: null,
      sourcePositions: positions,
      reason: 'SOURCE_INVALID',
    };
  }
  const descriptions = selectedBars.map(display);
  const signatures = selectedBars.map((bar) => `${bar.rawD}|${bar.pitchMm}|${bar.strength ?? ''}`);
  if (new Set(signatures).size !== 1) {
    return {
      status: 'AMBIGUOUS',
      display: null,
      sourcePositions: positions,
      reason: 'DIFFERING_BAR_SPECS',
    };
  }
  return { status: 'VALID', display: descriptions[0], sourcePositions: positions, reason };
}

/**
 * Returns eight canonical short/long × top/bottom × end/center list cells,
 * plus explicit non-banded cells for patterns whose meaning is not equivalent.
 * Full original barPositions stay on the section input and are never consumed.
 */
export function projectSlabSectionToList(section) {
  const pattern = section.barPattern;
  const version202 = String(section.version || '').startsWith('2.0.2');
  const knownVersion = version202 || /^2\.1\.[01]$/.test(String(section.version || ''));
  const candidates = new Map();
  for (const bar of section.barPositions || []) {
    if (!candidates.has(bar.pos)) candidates.set(bar.pos, []);
    candidates.get(bar.pos).push(bar);
  }
  const lookup = (positions) => {
    const matched = positions.flatMap((pos) => candidates.get(pos) || []);
    // Duplicated positions must not result in a successful cell.
    if (matched.length > positions.length) {
      return {
        status: 'AMBIGUOUS',
        display: null,
        sourcePositions: positions,
        reason: 'DUPLICATE_POS',
      };
    }
    return makeCell(positions, matched);
  };
  const cells = {};
  const notes = [];
  const extraCells = {};
  for (const direction of DIRECTIONS) {
    for (const face of FACES) {
      for (const zone of ZONES) {
        const key = `${direction}_${face}_${zone}`;
        if (pattern === 'STANDARD') {
          const prefix = `${direction}_${face}`;
          // COLUMN and MID_END describe different strips. One displayed
          // END value is safe only if both have identical specifications.
          const source =
            zone === 'END' ? [`${prefix}_COLUMN`, `${prefix}_MID_END`] : [`${prefix}_MID_CENTER`];
          cells[key] = lookup(source);
        } else if (pattern === '2WAY' && knownVersion && !version202) {
          cells[key] = lookup([key]);
        } else {
          cells[key] = makeCell([], [], { reason: 'NO_EQUIVALENT_POSITION' });
        }
      }
    }
  }
  if (pattern === 'STANDARD') {
    for (const [key, cell] of Object.entries(cells)) {
      if (cell.status === 'AMBIGUOUS') notes.push(`${key}: column/mid-end specifications differ`);
    }
  } else if (pattern === '2WAY' && version202) {
    notes.push('STB 2.0.2 2WAY is unzoned; end/center cells are not inferred');
    for (const direction of DIRECTIONS)
      for (const face of FACES) {
        const key = `${direction}_${face}`;
        extraCells[key] = lookup([key]);
      }
  } else if (pattern === '2WAY' && !knownVersion) {
    notes.push('Unknown STB version; 2WAY position semantics are unverified');
  } else if (pattern === '1WAY1' || pattern === '1WAY2') {
    notes.push('MAIN/TRANSVERSE cannot be inferred as SHORT/LONG');
    const positions =
      pattern === '1WAY1'
        ? ['MAIN_TOP', 'MAIN_BOTTOM', 'TRANSVERSE_TOP', 'TRANSVERSE_BOTTOM']
        : [
            'MAIN_BASE_TOP',
            'MAIN_BASE_BOTTOM',
            'MAIN_TIP_TOP',
            'MAIN_TIP_BOTTOM',
            'TRANSVERSE_TOP',
            'TRANSVERSE_BOTTOM',
          ];
    for (const pos of positions) extraCells[pos] = lookup([pos]);
    if (pattern === '1WAY2') notes.push('BASE/TIP cannot be inferred as END/CENTER');
  } else if (pattern === null) {
    notes.push('Reinforcement is missing; cells are intentionally blank');
  } else if (pattern !== 'STANDARD' && pattern !== '2WAY') {
    notes.push('Unsupported or ambiguous reinforcement pattern');
  }
  if ((section.barPositions || []).some((bar) => bar.problems.length)) {
    notes.push('Invalid/duplicate/unknown positions retained in detail; no estimated values');
  }
  return {
    id: section.id,
    symbol: section.symbol,
    sectionId: section.stb.sectionId,
    usage: section.usage,
    memberIds: section.stb.memberIds,
    storyIds: section.stb.storyIds,
    shape: section.shape,
    barPattern: pattern,
    cells,
    extraCells,
    notes,
    detailBars: section.barPositions,
    openingBars: section.openingBars,
    unsupportedBars: section.unsupportedBars,
    diagnostics: section.diagnostics,
  };
}

export function projectSlabSectionsToList(extracted) {
  return extracted.sections.map(projectSlabSectionToList);
}
