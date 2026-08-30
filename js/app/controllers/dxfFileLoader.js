/**
 * @fileoverview DXFファイル読み込みコアロジック
 *
 * DXFファイルの読み込み、パース、エンコーディング検出、レンダリングオプション計算を担当します。
 */

import { createLogger } from '../../utils/logger.js';
import { parseDxf, extractEntities, getLayers, calculateBounds } from '../../parser/dxfParser.js';
import {
  renderDxfEntities,
  clearDxfGroup,
  getDxfGroup,
  fitCameraToDxfBounds,
  setLayerVisibility,
  scene,
  camera,
  controls,
} from '../../viewer/index.js';
import { setState } from '../../data/state/globalState.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import { getCurrentStories, getCurrentAxesData, showError } from '../dxfLoaderHelpers.js';

const log = createLogger('DXFLoader');

// DXF状態管理
let currentDxfData = null;
let currentEntities = null;
let currentLayers = [];

/**
 * 現在のDXFエンティティを取得
 * @returns {Object|null} エンティティデータ
 */
export function getCurrentEntities() {
  return currentEntities;
}

/**
 * 現在のDXFレイヤーを取得
 * @returns {Array} レイヤー配列
 */
export function getCurrentLayers() {
  return currentLayers;
}

/**
 * DXF配置オプションを取得
 * @returns {Object} 配置オプション {plane, offsetX, offsetY, offsetZ, rotation}
 */
export function getDxfPlacementOptions() {
  const planeSelect = document.getElementById('dxfPlacementPlane');
  const positionSelect = document.getElementById('dxfPlacementPosition');
  const manualOffsetCheckbox = document.getElementById('dxfManualOffset');
  const offsetXInput = document.getElementById('dxfOffsetX');
  const offsetYInput = document.getElementById('dxfOffsetY');
  const offsetZInput = document.getElementById('dxfOffsetZ');

  const plane = planeSelect?.value || 'xy';
  const position = positionSelect?.value || 'origin';
  const useManualOffset = manualOffsetCheckbox?.checked || false;

  let offsetX = 0;
  let offsetY = 0;
  let offsetZ = 0;

  if (useManualOffset) {
    // 手動オフセットを使用
    offsetX = parseFloat(offsetXInput?.value) || 0;
    offsetY = parseFloat(offsetYInput?.value) || 0;
    offsetZ = parseFloat(offsetZInput?.value) || 0;
  } else if (position !== 'origin') {
    // 階または通りの位置を使用
    const positionData = getPositionFromSelection(plane, position);
    offsetX = positionData.offsetX;
    offsetY = positionData.offsetY;
    offsetZ = positionData.offsetZ;
  }

  return {
    plane,
    position,
    offsetX,
    offsetY,
    offsetZ,
    useManualOffset,
  };
}

/**
 * 選択された配置位置から実際のオフセット値を計算
 * @param {string} plane - 配置面 ('xy', 'xz', 'yz')
 * @param {string} position - 配置位置の識別子
 * @returns {Object} オフセット値 {offsetX, offsetY, offsetZ}
 */
function getPositionFromSelection(plane, position) {
  const planeHandlers = {
    xy: () => {
      // XY平面 - 階への配置
      const story = getCurrentStories().find((s) => s.id === position);
      if (story) {
        log.info(`階 "${story.name}" (高さ: ${story.height}mm) に配置`);
        return { offsetZ: story.height };
      }
      return {};
    },
    xz: () => {
      // XZ平面 - Y通りへの配置
      const axesData = getCurrentAxesData();
      const axis = axesData?.yAxes?.find((a) => a.id === position);
      if (axis) {
        log.info(`Y通り "${axis.name}" (距離: ${axis.distance}mm) に配置`);
        return { offsetY: axis.distance };
      }
      return {};
    },
    yz: () => {
      // YZ平面 - X通りへの配置
      const axesData = getCurrentAxesData();
      const axis = axesData?.xAxes?.find((a) => a.id === position);
      if (axis) {
        log.info(`X通り "${axis.name}" (距離: ${axis.distance}mm) に配置`);
        return { offsetX: axis.distance };
      }
      return {};
    },
  };

  const offsets = planeHandlers[plane]?.() ?? {};
  return { offsetX: 0, offsetY: 0, offsetZ: 0, ...offsets };
}

/**
 * DXFファイルを読み込んで表示
 * @param {File} file - DXFファイル
 * @param {Object} options - 配置オプション（省略時はUIから取得）
 * @returns {Promise<boolean>} 読み込み成功フラグ
 */
export async function loadDxfFile(file, options = null) {
  try {
    log.info('DXFファイル読み込み開始:', file.name);

    // 配置オプションを取得（引数が無ければUIから取得）
    const placementOptions = options || getDxfPlacementOptions();
    log.info('配置オプション:', placementOptions);

    // ファイル内容を読み込み
    const content = await readFileAsText(file);

    // DXFをパース
    currentDxfData = parseDxf(content);

    // エンティティを抽出
    currentEntities = extractEntities(currentDxfData);

    // レイヤー情報を取得
    currentLayers = getLayers(currentDxfData);

    // バウンドを計算
    const bounds = calculateBounds(currentEntities);

    // シーンを確認
    if (!scene) {
      throw new Error('シーンが初期化されていません');
    }

    // DXFグループをシーンに追加
    const dxfGroup = getDxfGroup();
    if (!scene.getObjectByName('DXFEntities')) {
      scene.add(dxfGroup);
    }

    // 配置面に応じた回転とオフセットを計算
    const renderOptions = calculateRenderOptions(placementOptions);

    // エンティティを描画
    renderDxfEntities(currentEntities, renderOptions);

    // カメラを調整
    if (camera && controls) {
      fitCameraToDxfBounds(bounds, camera, controls);
    }

    // 再描画をリクエスト
    scheduleRender();

    // 状態を更新
    setState('dxf.loaded', true);
    setState('dxf.data', currentDxfData);
    setState('dxf.entities', currentEntities);
    setState('dxf.layers', currentLayers);
    setState('dxf.bounds', bounds);
    setState('dxf.placementOptions', placementOptions);

    // レイヤーUI を更新
    updateLayerUI();

    log.info('DXFファイル読み込み完了:', {
      entities: {
        lines: currentEntities.lines.length,
        polylines: currentEntities.lwpolylines.length,
        circles: currentEntities.circles.length,
        arcs: currentEntities.arcs.length,
        dimensions: currentEntities.dimensions.length,
        texts: currentEntities.texts.length,
      },
      layers: currentLayers.length,
      placement: placementOptions,
    });

    return true;
  } catch (error) {
    log.error('DXFファイル読み込みエラー:', error);
    showError(`DXFファイルの読み込みに失敗しました: ${error.message}`);
    return false;
  }
}

/**
 * 配置オプションからレンダリングオプションを計算
 * @param {Object} placementOptions - 配置オプション
 * @returns {Object} レンダリングオプション
 */
export function calculateRenderOptions(placementOptions) {
  const { plane, offsetX, offsetY, offsetZ } = placementOptions;

  // 基本オプション
  const renderOptions = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
    plane: plane, // 配置面情報を渡す
  };

  // 配置面に応じてオフセットを設定
  switch (plane) {
    case 'xy':
      // XY平面（平面図） - DXFのX,YはそのままX,Y、オフセットはZ方向
      renderOptions.offsetX = offsetX;
      renderOptions.offsetY = offsetY;
      renderOptions.offsetZ = offsetZ;
      break;

    case 'xz':
      // XZ平面（Y通り断面） - DXFのX→X, Y→Z、オフセットはY方向
      renderOptions.offsetX = offsetX;
      renderOptions.offsetY = offsetY;
      renderOptions.offsetZ = offsetZ;
      renderOptions.swapYZ = true; // Y軸とZ軸を交換
      break;

    case 'yz':
      // YZ平面（X通り断面） - DXFのX→Y, Y→Z、オフセットはX方向
      renderOptions.offsetX = offsetX;
      renderOptions.offsetY = offsetY;
      renderOptions.offsetZ = offsetZ;
      renderOptions.swapXYZ = true; // 座標を回転
      break;
  }

  return renderOptions;
}

/**
 * DXFファイルのコードページからエンコーディングを推定
 * @param {ArrayBuffer} buffer - ファイルのバイナリデータ
 * @returns {string} エンコーディング名
 */
export function detectDxfEncoding(buffer) {
  // まずASCIIとして読み込んでヘッダーを確認
  const uint8 = new Uint8Array(buffer);
  let headerText = '';

  // 最初の4KB程度を確認（ヘッダー情報はファイル先頭にある）
  const headerLength = Math.min(4096, uint8.length);
  for (let i = 0; i < headerLength; i++) {
    headerText += String.fromCharCode(uint8[i]);
  }

  // $DWGCODEPAGEを検索
  const codepageMatch = headerText.match(/\$DWGCODEPAGE[\s\S]*?\n\s*3\s*\n([^\n]+)/i);
  if (codepageMatch) {
    const codepage = codepageMatch[1].trim().toUpperCase();
    log.info('DXFコードページ検出:', codepage);

    // コードページからエンコーディングへのマッピング
    const codepageMap = {
      ANSI_932: 'shift_jis', // Japanese
      ANSI_936: 'gb2312', // Simplified Chinese
      ANSI_949: 'euc-kr', // Korean
      ANSI_950: 'big5', // Traditional Chinese
      ANSI_1250: 'windows-1250', // Central European
      ANSI_1251: 'windows-1251', // Cyrillic
      ANSI_1252: 'windows-1252', // Western European
      ANSI_1253: 'windows-1253', // Greek
      ANSI_1254: 'windows-1254', // Turkish
      ANSI_1255: 'windows-1255', // Hebrew
      ANSI_1256: 'windows-1256', // Arabic
      ANSI_1257: 'windows-1257', // Baltic
      ANSI_1258: 'windows-1258', // Vietnamese
      'UTF-8': 'utf-8',
      UTF8: 'utf-8',
    };

    if (codepageMap[codepage]) {
      return codepageMap[codepage];
    }

    // ANSI_xxxの形式をパース
    const ansiMatch = codepage.match(/ANSI_(\d+)/);
    if (ansiMatch) {
      const cpNum = ansiMatch[1];
      // 日本語環境でよく使われるCP932
      if (cpNum === '932') {
        return 'shift_jis';
      }
    }
  }

  // BOM（Byte Order Mark）を確認
  if (uint8[0] === 0xef && uint8[1] === 0xbb && uint8[2] === 0xbf) {
    log.info('UTF-8 BOM検出');
    return 'utf-8';
  }
  if (uint8[0] === 0xff && uint8[1] === 0xfe) {
    log.info('UTF-16LE BOM検出');
    return 'utf-16le';
  }
  if (uint8[0] === 0xfe && uint8[1] === 0xff) {
    log.info('UTF-16BE BOM検出');
    return 'utf-16be';
  }

  // 日本語環境向け: Shift_JISの特徴的なバイトパターンを検出
  let shiftJisScore = 0;
  let utf8Score = 0;

  for (let i = 0; i < Math.min(buffer.byteLength, 8192); i++) {
    const b = uint8[i];

    // Shift_JIS特徴的パターン（全角文字の先頭バイト）
    if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) {
      const next = uint8[i + 1];
      if (next && ((next >= 0x40 && next <= 0x7e) || (next >= 0x80 && next <= 0xfc))) {
        shiftJisScore += 2;
        i++; // 2バイト文字なのでスキップ
      }
    }

    // UTF-8特徴的パターン（マルチバイトシーケンス）
    if ((b & 0xe0) === 0xc0) {
      // 2バイトシーケンス開始
      const next = uint8[i + 1];
      if (next && (next & 0xc0) === 0x80) {
        utf8Score += 2;
        i++;
      }
    } else if ((b & 0xf0) === 0xe0) {
      // 3バイトシーケンス開始
      const next1 = uint8[i + 1];
      const next2 = uint8[i + 2];
      if (next1 && next2 && (next1 & 0xc0) === 0x80 && (next2 & 0xc0) === 0x80) {
        utf8Score += 3;
        i += 2;
      }
    }
  }

  log.info('エンコーディング推定スコア:', { shiftJis: shiftJisScore, utf8: utf8Score });

  // スコアが高い方を選択
  if (shiftJisScore > utf8Score && shiftJisScore > 5) {
    log.info('Shift_JISと推定');
    return 'shift_jis';
  }

  if (utf8Score > 5) {
    log.info('UTF-8と推定');
    return 'utf-8';
  }

  // デフォルト: 日本語環境ではShift_JISが多いが、新しいファイルはUTF-8の可能性も
  // 安全のためUTF-8を試し、失敗したらShift_JISにフォールバック
  log.info('エンコーディング不明、UTF-8をデフォルトとして使用');
  return 'utf-8';
}

/**
 * ファイルをテキストとして読み込む（自動エンコーディング検出）
 * @param {File} file - ファイル
 * @returns {Promise<string>} ファイル内容
 */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const buffer = e.target.result;
        const encoding = detectDxfEncoding(buffer);

        // 検出したエンコーディングでデコード
        let text;
        try {
          const decoder = new TextDecoder(encoding);
          text = decoder.decode(buffer);
        } catch (decodeError) {
          // エンコーディングがサポートされていない場合、Shift_JISを試す
          log.warn(`${encoding}でのデコード失敗、Shift_JISを試行:`, decodeError);
          try {
            const fallbackDecoder = new TextDecoder('shift_jis');
            text = fallbackDecoder.decode(buffer);
          } catch (fallbackError) {
            // 最終フォールバック: UTF-8
            log.warn('Shift_JISでもデコード失敗、UTF-8でフォールバック');
            const utf8Decoder = new TextDecoder('utf-8');
            text = utf8Decoder.decode(buffer);
          }
        }

        resolve(text);
      } catch (error) {
        reject(new Error('ファイル読み込みエラー: ' + error.message));
      }
    };
    reader.onerror = () => reject(new Error('ファイル読み込みエラー'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * DXFデータをクリア
 */
export function clearDxfData() {
  clearDxfGroup();
  currentDxfData = null;
  currentEntities = null;
  currentLayers = [];

  setState('dxf.loaded', false);
  setState('dxf.data', null);
  setState('dxf.entities', null);
  setState('dxf.layers', null);

  // 再描画をリクエスト
  scheduleRender();

  log.info('DXFデータをクリアしました');
}

/**
 * レイヤーの表示/非表示を切り替え
 * @param {string} layerName - レイヤー名
 * @param {boolean} visible - 表示状態
 */
export function toggleDxfLayer(layerName, visible) {
  setLayerVisibility(layerName, visible);

  // 再描画をリクエスト
  scheduleRender();
}

/**
 * レイヤーUIを更新
 */
function updateLayerUI() {
  const layerContainer = document.getElementById('dxf-layer-list');
  if (!layerContainer) return;

  layerContainer.innerHTML = '';

  for (const layer of currentLayers) {
    const layerItem = document.createElement('label');
    layerItem.className = 'dxf-layer-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = layer.visible;
    checkbox.addEventListener('change', (e) => {
      toggleDxfLayer(layer.name, e.target.checked);
    });

    const colorBox = document.createElement('span');
    colorBox.className = 'dxf-layer-color';
    colorBox.style.backgroundColor = `#${layer.color.toString(16).padStart(6, '0')}`;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = layer.name;

    layerItem.appendChild(checkbox);
    layerItem.appendChild(colorBox);
    layerItem.appendChild(nameSpan);
    layerContainer.appendChild(layerItem);
  }
}

/**
 * 配置情報のテキストを取得
 * @param {Object} options - 配置オプション
 * @returns {string} 配置情報テキスト
 */
export function getPlacementInfoText(options) {
  const planeNames = {
    xy: 'XY平面',
    xz: 'XZ平面',
    yz: 'YZ平面',
  };

  let text = planeNames[options.plane] || options.plane;

  if (options.useManualOffset) {
    text += ` (手動: X=${options.offsetX}, Y=${options.offsetY}, Z=${options.offsetZ}mm)`;
  } else if (options.position !== 'origin') {
    // 階または通りの名前を取得
    const stories = getCurrentStories();
    const axesData = getCurrentAxesData();

    if (options.plane === 'xy') {
      const story = stories.find((s) => s.id === options.position);
      if (story) {
        text += ` → ${story.name}`;
      }
    } else if (options.plane === 'xz') {
      const axis = axesData?.yAxes?.find((a) => a.id === options.position);
      if (axis) {
        text += ` → ${axis.name}通り`;
      }
    } else if (options.plane === 'yz') {
      const axis = axesData?.xAxes?.find((a) => a.id === options.position);
      if (axis) {
        text += ` → ${axis.name}通り`;
      }
    }
  } else {
    text += ' → 原点';
  }

  return text;
}
