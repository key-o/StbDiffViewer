/**
 * @fileoverview アコーディオンUIイベントリスナー
 *
 * アコーディオンセクションの展開/折り畳みを処理するイベントリスナー。
 *
 * @module ui/events/accordionListeners
 */

import { storageHelper } from '../../utils/storageHelper.js';
import { createLogger, LogCategory } from '../../utils/logger.js';

const logger = createLogger('ui:accordion');

/** @type {Element[]} */
let _registeredHeaders = [];

/**
 * Setup accordion event listeners
 */
export function setupAccordionListeners() {
  const accordionHeaders = document.querySelectorAll('.accordion-header');

  accordionHeaders.forEach((header) => {
    header.addEventListener('click', handleAccordionToggle);
    _registeredHeaders.push(header);
  });

  // Initialize accordion states
  initializeAccordionStates();
}

/**
 * Teardown accordion event listeners
 */
export function teardownAccordionListeners() {
  for (const header of _registeredHeaders) {
    header.removeEventListener('click', handleAccordionToggle);
  }
  _registeredHeaders = [];
}

/**
 * Handle accordion section toggle
 * @param {Event} event - Click event
 */
function handleAccordionToggle(event) {
  const header = event.currentTarget;
  const targetId = header.dataset.target;
  const content = document.getElementById(targetId);

  if (!content) {
    logger.warn(`アコーディオン: コンテンツが見つかりません (target=${targetId})`);
    return;
  }

  const isCollapsed = content.classList.contains('collapsed');

  if (isCollapsed) {
    // Expand
    content.classList.remove('collapsed');
    content.removeAttribute('inert');
    header.classList.remove('collapsed');
    header.setAttribute('aria-expanded', 'true');
    content.setAttribute('aria-hidden', 'false');
    logger.info(`${LogCategory.EVENT} アコーディオン展開: ${targetId}`);
  } else {
    // Collapse
    content.classList.add('collapsed');
    content.setAttribute('inert', '');
    header.classList.add('collapsed');
    header.setAttribute('aria-expanded', 'false');
    content.setAttribute('aria-hidden', 'true');
    logger.info(`${LogCategory.EVENT} アコーディオン折畳: ${targetId}`);
  }

  // Save accordion state to localStorage
  saveAccordionState(targetId, !isCollapsed);
}

/**
 * Initialize accordion states from localStorage or defaults
 */
function initializeAccordionStates() {
  const defaultOpenSections = ['file-loading', 'display-settings', 'element-settings'];
  const accordionSections = document.querySelectorAll('.accordion-section');

  accordionSections.forEach((section, _index) => {
    const header = section.querySelector('.accordion-header');
    const content = section.querySelector('.accordion-content');

    if (!header || !content) return;

    const targetId = header.dataset.target;
    const savedState = getAccordionState(targetId);
    const shouldBeOpen = savedState !== null ? savedState : defaultOpenSections.includes(targetId);

    if (shouldBeOpen) {
      content.classList.remove('collapsed');
      content.removeAttribute('inert');
      header.classList.remove('collapsed');
      header.setAttribute('aria-expanded', 'true');
      content.setAttribute('aria-hidden', 'false');
    } else {
      content.classList.add('collapsed');
      content.setAttribute('inert', '');
      header.classList.add('collapsed');
      header.setAttribute('aria-expanded', 'false');
      content.setAttribute('aria-hidden', 'true');
    }
  });
}

/**
 * Save accordion state to storageHelper
 * @param {string} sectionId - Section identifier
 * @param {boolean} isOpen - Whether section is open
 */
function saveAccordionState(sectionId, isOpen) {
  const accordionStates = storageHelper.get('accordionStates', {});
  accordionStates[sectionId] = isOpen;
  storageHelper.set('accordionStates', accordionStates);
}

/**
 * Get accordion state from storageHelper
 * @param {string} sectionId - Section identifier
 * @returns {boolean|null} Saved state or null if not found
 */
function getAccordionState(sectionId) {
  const accordionStates = storageHelper.get('accordionStates', {});
  return accordionStates[sectionId] !== undefined ? accordionStates[sectionId] : null;
}

/**
 * Expand all accordion sections
 */
export function expandAllAccordions() {
  const contents = document.querySelectorAll('.accordion-content');
  const headers = document.querySelectorAll('.accordion-header');

  contents.forEach((content) => {
    content.classList.remove('collapsed');
    content.removeAttribute('inert');
    content.setAttribute('aria-hidden', 'false');
  });
  headers.forEach((header) => {
    header.classList.remove('collapsed');
    header.setAttribute('aria-expanded', 'true');
  });

  // Save states
  headers.forEach((header) => {
    const targetId = header.dataset.target;
    saveAccordionState(targetId, true);
  });

  logger.info(`${LogCategory.EVENT} 全アコーディオン展開`);
}

/**
 * Collapse all accordion sections
 */
export function collapseAllAccordions() {
  const contents = document.querySelectorAll('.accordion-content');
  const headers = document.querySelectorAll('.accordion-header');

  contents.forEach((content) => {
    content.classList.add('collapsed');
    content.setAttribute('inert', '');
    content.setAttribute('aria-hidden', 'true');
  });
  headers.forEach((header) => {
    header.classList.add('collapsed');
    header.setAttribute('aria-expanded', 'false');
  });

  // Save states
  headers.forEach((header) => {
    const targetId = header.dataset.target;
    saveAccordionState(targetId, false);
  });

  logger.info(`${LogCategory.EVENT} 全アコーディオン折畳`);
}

/**
 * Get accordion section count
 * @returns {number} Number of accordion sections
 */
export function getAccordionSectionCount() {
  return document.querySelectorAll('.accordion-section').length;
}
