/** Android Chromeのみでナビゲーション用オフラインフォールバックを登録する。 */
if (
  typeof navigator !== 'undefined' &&
  /Android/i.test(navigator.userAgent) &&
  window.isSecureContext &&
  'serviceWorker' in navigator
) {
  window.addEventListener(
    'load',
    () => {
      navigator.serviceWorker
        .register(new URL('./sw.js', document.baseURI), { scope: './' })
        .catch((error) => console.warn('[Android PWA] Service Worker registration failed:', error));
    },
    { once: true },
  );
}
