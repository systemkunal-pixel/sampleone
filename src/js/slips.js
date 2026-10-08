// Bank deposit slip storage. Images are too large for localStorage, so they live in IndexedDB.

const DB = 'loan-recovery-slips';
const STORE = 'slips';
export const MAX_SLIP_BYTES = 5 * 1024 * 1024;
const MAX_EDGE = 1600; // px — keeps slip text legible while shrinking phone photos ~10x

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const putSlip = (id, blob) => tx('readwrite', (s) => s.put(blob, id));
export const getSlip = (id) => tx('readonly', (s) => s.get(id));
export const deleteSlip = (id) => tx('readwrite', (s) => s.delete(id));
export const clearSlips = () => tx('readwrite', (s) => s.clear());

/** Downscales a photo to JPEG; PDFs and small JPEG/PNG/WebP images are kept as-is. */
export async function prepareSlip(file) {
  if (!file) throw new Error('Attach a photo of the deposit slip.');
  const isImage = file.type.startsWith('image/');
  if (!isImage && file.type !== 'application/pdf') throw new Error('Slip must be a photo or a PDF.');
  if (!isImage) {
    if (file.size > MAX_SLIP_BYTES) throw new Error('PDF is larger than 5 MB.');
    return file;
  }
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('Could not read that image. Try taking the photo again.');
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  // The server accepts JPEG/PNG/WebP; anything else (e.g. HEIC) is re-encoded as JPEG.
  const webSafe = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
  if (scale === 1 && webSafe && file.size < 400 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
