// Home-screen install and storage protection.

let deferredPrompt = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

export const onInstallChange = (fn) => listeners.add(fn);

export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/** iPhone/iPad Safari has no install prompt; users add it from the Share menu. */
export function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** 'installed' | 'prompt' (one-tap install available) | 'ios' (manual steps) | 'unavailable' */
export function installState() {
  if (isStandalone()) return 'installed';
  if (deferredPrompt) return 'prompt';
  if (isIOS()) return 'ios';
  return 'unavailable';
}

export async function promptInstall() {
  if (!deferredPrompt) return false;
  const ev = deferredPrompt;
  deferredPrompt = null;
  ev.prompt();
  const { outcome } = await ev.userChoice;
  notify();
  return outcome === 'accepted';
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // show our own button instead of the mini-infobar
  deferredPrompt = e;
  notify();
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  notify();
});

/**
 * Asks the browser not to evict our data under storage pressure.
 * Chrome grants this automatically for installed apps; Safari for home-screen apps.
 */
export async function protectStorage() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

export async function storageInfo() {
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
  return { persisted, usage: est.usage || 0, quota: est.quota || 0 };
}

const BANNER_KEY = 'loan-recovery:install-banner-dismissed';
export function bannerDismissed() {
  try {
    return localStorage.getItem(BANNER_KEY) === '1';
  } catch {
    return false;
  }
}
export function dismissBanner() {
  try {
    localStorage.setItem(BANNER_KEY, '1');
  } catch {}
}
