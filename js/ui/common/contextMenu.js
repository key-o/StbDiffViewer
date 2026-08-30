/**
 * コンテキストメニューコンポーネント
 *
 * 要素ツリー・断面ツリー・3Dビューで使用する右クリックメニュー
 */

/** @type {HTMLElement|null} */
let menuElement = null;

/**
 * コンテキストメニューを初期化
 */
export function initializeContextMenu() {
  // 既存のメニューがあれば削除
  if (menuElement) {
    menuElement.remove();
  }

  // メニュー要素を作成
  menuElement = document.createElement('div');
  menuElement.id = 'context-menu';
  menuElement.className = 'context-menu';
  menuElement.style.cssText = `
    position: fixed;
    display: none;
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    min-width: 180px;
    max-width: 280px;
    z-index: 10000;
    padding: 4px 0;
    font-size: var(--font-size-sm);
    color: #e0e0e0;
  `;

  document.body.appendChild(menuElement);

  // グローバルクリックでメニューを閉じる
  document.addEventListener('click', hideContextMenu);
  // メニュー外での右クリックは閉じる。
  // captureフェーズで登録: バブリングだと、canvas等のcontextmenuハンドラーが
  // showContextMenu() した直後に同じイベントがdocumentへ到達して即閉じてしまい、
  // メニューが一度も表示されない。captureなら「閉じる判定→表示」の順になる。
  document.addEventListener(
    'contextmenu',
    (e) => {
      if (menuElement && !menuElement.contains(e.target)) {
        hideContextMenu();
      }
    },
    true,
  );

  // ESCキーでメニューを閉じる
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
    }
  });
}

/**
 * コンテキストメニューを表示
 * @param {number} x - X座標
 * @param {number} y - Y座標
 * @param {Array<MenuItemConfig>} items - メニュー項目の配列
 *
 * @typedef {Object} MenuItemConfig
 * @property {string} label - 表示テキスト
 * @property {string} [icon] - アイコン（絵文字）
 * @property {Function} [action] - クリック時のアクション
 * @property {boolean} [disabled] - 無効化フラグ
 * @property {boolean} [separator] - 区切り線フラグ
 * @property {string} [shortcut] - ショートカットキー表示
 */
export function showContextMenu(x, y, items) {
  if (!menuElement) {
    initializeContextMenu();
  }

  // メニュー内容をクリア
  menuElement.innerHTML = '';

  // メニュー項目を作成
  items.forEach((item) => {
    if (item.separator) {
      const separator = document.createElement('div');
      separator.className = 'context-menu-separator';
      separator.style.cssText = `
        height: 1px;
        background: #555;
        margin: 4px 8px;
      `;
      menuElement.appendChild(separator);
      return;
    }

    const menuItem = document.createElement('div');
    menuItem.className = 'context-menu-item';
    menuItem.style.cssText = `
      padding: 6px 12px;
      cursor: ${item.disabled ? 'default' : 'pointer'};
      display: flex;
      align-items: center;
      justify-content: space-between;
      opacity: ${item.disabled ? '0.5' : '1'};
      transition: background 0.1s;
    `;

    // アイコンとラベル
    const labelContainer = document.createElement('span');
    labelContainer.style.cssText = 'display: flex; align-items: center; gap: 8px;';

    if (item.icon) {
      const icon = document.createElement('span');
      icon.textContent = item.icon;
      icon.style.cssText = 'width: 16px; text-align: center;';
      labelContainer.appendChild(icon);
    }

    const label = document.createElement('span');
    label.textContent = item.label;
    labelContainer.appendChild(label);

    menuItem.appendChild(labelContainer);

    // ショートカット表示
    if (item.shortcut) {
      const shortcut = document.createElement('span');
      shortcut.textContent = item.shortcut;
      shortcut.style.cssText = 'font-size: var(--font-size-sm); color: #888; margin-left: 16px;';
      menuItem.appendChild(shortcut);
    }

    // ホバー効果
    if (!item.disabled) {
      menuItem.addEventListener('mouseenter', () => {
        menuItem.style.background = '#3d3d3d';
      });
      menuItem.addEventListener('mouseleave', () => {
        menuItem.style.background = 'transparent';
      });

      // クリックアクション
      menuItem.addEventListener('click', (e) => {
        e.stopPropagation();
        hideContextMenu();
        if (item.action) {
          item.action();
        }
      });
    }

    menuElement.appendChild(menuItem);
  });

  // 位置を調整（画面外に出ないように）
  menuElement.style.display = 'block';
  const menuRect = menuElement.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let adjustedX = x;
  let adjustedY = y;

  if (x + menuRect.width > viewportWidth) {
    adjustedX = viewportWidth - menuRect.width - 8;
  }
  if (y + menuRect.height > viewportHeight) {
    adjustedY = viewportHeight - menuRect.height - 8;
  }

  menuElement.style.left = `${adjustedX}px`;
  menuElement.style.top = `${adjustedY}px`;
}

/**
 * コンテキストメニューを非表示
 */
function hideContextMenu() {
  if (menuElement) {
    menuElement.style.display = 'none';
  }
}
