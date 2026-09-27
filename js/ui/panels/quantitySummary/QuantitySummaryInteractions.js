export function bindQuantitySummaryInteractions(root, handlers = {}) {
  if (!root) return () => {};

  const onChange = (event) => {
    const control = event.target?.dataset?.quantityControl;
    if (control) {
      handlers.onControlChange?.(control, event.target.value);
      return;
    }
    const status = event.target?.dataset?.quantityStatus;
    if (status) handlers.onStatusChange?.(status, Boolean(event.target.checked));
  };

  const notifyFactSelection = (row) => {
    handlers.onFactSelect?.({
      modelSide: row.dataset.quantityFactSide,
      elementType: row.dataset.quantityFactType,
      elementId: row.dataset.quantityFactId,
      memberCategory: row.dataset.quantityMemberCategory,
    });
  };

  const onClick = (event) => {
    const exportButton = event.target?.closest?.('[data-quantity-export]');
    if (exportButton && root.contains(exportButton)) {
      handlers.onExport?.(exportButton.dataset.quantityExport);
      return;
    }

    const closeDrilldown = event.target?.closest?.('[data-quantity-drilldown-close]');
    if (closeDrilldown && root.contains(closeDrilldown)) {
      handlers.onDrilldownClose?.();
      return;
    }

    const drilldownPageButton = event.target?.closest?.('[data-quantity-drilldown-page]');
    if (drilldownPageButton && root.contains(drilldownPageButton)) {
      const page = Number(drilldownPageButton.dataset.quantityDrilldownPage);
      if (Number.isInteger(page) && page > 0) handlers.onDrilldownPageChange?.(page);
      return;
    }

    const factRow = event.target?.closest?.('[data-quantity-fact-id]');
    if (factRow && root.contains(factRow)) {
      notifyFactSelection(factRow);
      return;
    }

    const groupRow = event.target?.closest?.('[data-quantity-group-key]');
    if (groupRow && root.contains(groupRow)) {
      handlers.onGroupOpen?.(groupRow.dataset.quantityGroupKey);
      return;
    }

    const pageButton = event.target?.closest?.('[data-quantity-page]');
    if (pageButton && root.contains(pageButton)) {
      const page = Number(pageButton.dataset.quantityPage);
      if (Number.isInteger(page) && page > 0) handlers.onPageChange?.(page);
      return;
    }

    const sortButton = event.target?.closest?.('[data-quantity-sort]');
    if (!sortButton || !root.contains(sortButton)) return;
    handlers.onSort?.(sortButton.dataset.quantitySort);
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;

    const factRow = event.target?.closest?.('[data-quantity-fact-id]');
    if (factRow && root.contains(factRow)) {
      event.preventDefault();
      notifyFactSelection(factRow);
      return;
    }

    const groupRow = event.target?.closest?.('[data-quantity-group-key]');
    if (groupRow && root.contains(groupRow)) {
      event.preventDefault();
      handlers.onGroupOpen?.(groupRow.dataset.quantityGroupKey);
    }
  };

  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeyDown);
  return () => {
    root.removeEventListener('change', onChange);
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKeyDown);
  };
}
