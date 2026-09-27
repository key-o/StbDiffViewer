const TAB_STB = 'stb';
const TAB_DERIVED = 'derived';
const VALID_TABS = new Set([TAB_STB, TAB_DERIVED]);

let activeElementInfoTab = TAB_STB;

function normalizeTab(tab) {
  return VALID_TABS.has(tab) ? tab : TAB_STB;
}

function panelId(tab) {
  return `element-info-tab-panel-${tab}`;
}

function buttonId(tab) {
  return `element-info-tab-${tab}`;
}

function renderTabButton(tab, label, active) {
  return `<button type="button" class="element-info-tab${active ? ' is-active' : ''}" role="tab" id="${buttonId(tab)}" aria-controls="${panelId(tab)}" aria-selected="${active ? 'true' : 'false'}" tabindex="${active ? '0' : '-1'}" data-element-info-tab="${tab}">${label}</button>`;
}

function renderTabPanel(tab, html, active) {
  return `<section class="element-info-tab-panel" role="tabpanel" id="${panelId(tab)}" aria-labelledby="${buttonId(tab)}" data-element-info-tab-panel="${tab}"${active ? '' : ' hidden'}>${html}</section>`;
}

export function renderElementInfoTabs({
  stbHtml = '',
  derivedHtml = '',
  headerHtml = '',
  derivedEmptyMessage = 'この要素には算出情報がありません。',
  preferredTab = null,
} = {}) {
  const activeTab = normalizeTab(preferredTab || activeElementInfoTab);
  if (preferredTab) activeElementInfoTab = activeTab;
  const safeDerivedHtml =
    derivedHtml || `<div class="element-info-tab-empty">${derivedEmptyMessage}</div>`;

  return [
    '<div class="element-info-tabs" role="tablist" aria-label="要素情報の表示切替">',
    renderTabButton(TAB_STB, 'STB情報', activeTab === TAB_STB),
    renderTabButton(TAB_DERIVED, '算出情報', activeTab === TAB_DERIVED),
    '</div>',
    headerHtml,
    '<div class="element-info-tab-panels">',
    renderTabPanel(TAB_STB, stbHtml, activeTab === TAB_STB),
    renderTabPanel(TAB_DERIVED, safeDerivedHtml, activeTab === TAB_DERIVED),
    '</div>',
  ].join('');
}

export function mountElementInfoTabs(
  contentRoot,
  options = {},
  tabHost = globalThis.document?.getElementById('element-info-tabs-host') ?? null,
) {
  if (!contentRoot) return;

  contentRoot.innerHTML = renderElementInfoTabs(options);

  const tabList = contentRoot.querySelector('.element-info-tabs');
  if (tabHost && tabList) {
    tabHost.replaceChildren(tabList);
  }

  const interactionRoot = contentRoot.closest?.('#component-info') || contentRoot;
  setupElementInfoTabs(interactionRoot);
}

export function clearElementInfoTabHost(
  tabHost = globalThis.document?.getElementById('element-info-tabs-host') ?? null,
) {
  tabHost?.replaceChildren();
}

function activateTab(root, tab, { focus = false } = {}) {
  const nextTab = normalizeTab(tab);
  activeElementInfoTab = nextTab;

  const buttons = Array.from(root.querySelectorAll('[data-element-info-tab]'));
  const panels = Array.from(root.querySelectorAll('[data-element-info-tab-panel]'));

  for (const button of buttons) {
    const selected = button.dataset.elementInfoTab === nextTab;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }

  for (const panel of panels) {
    panel.hidden = panel.dataset.elementInfoTabPanel !== nextTab;
  }
}

function ensureElementInfoTabHost(root) {
  const panel = root?.closest?.('#component-info');
  if (!panel) return null;

  let host = panel.querySelector('#element-info-tabs-host');
  if (host) return host;

  const header = panel.querySelector('.float-window-header');
  if (!header) return null;

  host = panel.ownerDocument.createElement('div');
  host.id = 'element-info-tabs-host';
  host.className = 'element-info-tabs-host';
  header.insertAdjacentElement('afterend', host);
  return host;
}

function setupTabHostCleanupObserver(contentRoot, tabHost) {
  if (!contentRoot || !tabHost || contentRoot._elementInfoTabObserver) return;

  const MutationObserverCtor = contentRoot.ownerDocument?.defaultView?.MutationObserver;
  if (!MutationObserverCtor) return;

  const observer = new MutationObserverCtor(() => {
    if (!contentRoot.querySelector('[data-element-info-tab-panel]')) {
      tabHost.replaceChildren();
    }
  });
  observer.observe(contentRoot, { childList: true, subtree: true });
  contentRoot._elementInfoTabObserver = observer;
}

export function setupElementInfoTabs(root) {
  if (!root) return;

  const interactionRoot = root.closest?.('#component-info') || root;
  const tabHost = ensureElementInfoTabHost(root);
  const tabList = root.querySelector('.element-info-tabs');
  if (tabHost && tabList && tabList.parentElement !== tabHost) {
    tabHost.replaceChildren(tabList);
    setupTabHostCleanupObserver(root, tabHost);
  }

  const buttons = Array.from(interactionRoot.querySelectorAll('[data-element-info-tab]'));
  if (buttons.length === 0) return;

  activateTab(interactionRoot, activeElementInfoTab);

  for (const button of buttons) {
    button.addEventListener('click', () => {
      activateTab(interactionRoot, button.dataset.elementInfoTab);
    });

    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();

      const currentIndex = buttons.indexOf(button);
      let nextIndex = currentIndex;
      if (event.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
      } else if (event.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % buttons.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = buttons.length - 1;
      }

      activateTab(interactionRoot, buttons[nextIndex].dataset.elementInfoTab, { focus: true });
    });
  }
}

export function getActiveElementInfoTab() {
  return activeElementInfoTab;
}

export function resetElementInfoTabForTest() {
  activeElementInfoTab = TAB_STB;
}
