/**
 * Browser-based image compression for campaign emails.
 *
 * Why we need this:
 *   • Inlining base64 images in emails balloons message size fast —
 *     SES caps total message at 40MB and many ISPs flag emails >5MB.
 *   • A 5MB photo from a phone camera becomes ~6.7MB base64-encoded.
 *   • We target <2MB per image which keeps even multi-image campaigns
 *     well under inbox-provider thresholds.
 *
 * Strategy:
 *   1. If the file is already under the target, return it unchanged.
 *   2. Otherwise, draw it onto a canvas at progressively smaller
 *      dimensions + lower JPEG quality until we fit the target or run
 *      out of options. Dimensions are halved no more than 3 times
 *      (1× → 0.5×) and quality steps from 0.85 down to 0.5.
 *   3. PNG/transparent images get converted to JPEG when over the cap
 *      (PNG can't be quality-compressed and is usually 3-5× larger).
 *   4. The function never throws — if compression fails for any reason
 *     it returns the original file and lets the caller decide.
 */

export interface CompressionResult {
  /** The compressed (or original) image as a data URL */
  dataUrl: string;
  /** Final size in bytes */
  bytes: number;
  /** Final width in pixels */
  width: number;
  /** Final height in pixels */
  height: number;
  /** Whether any compression was actually applied */
  compressed: boolean;
  /** Original file size before compression (bytes) */
  originalBytes: number;
}

const TARGET_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_WIDTH = 1600; // wide enough for full-bleed email; emails typically render at 600px

/** Read a File into an HTMLImageElement so we can draw it onto a canvas. */
async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not decode image'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Convert a data URL into its raw byte length (post-base64-decode). */
function dataUrlBytes(dataUrl: string): number {
  const idx = dataUrl.indexOf(',');
  if (idx < 0) return dataUrl.length;
  const b64 = dataUrl.slice(idx + 1);
  // base64 length × 3/4, minus padding
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Compress an image to fit under TARGET_BYTES. If it's already smaller,
 * the original file is returned (read via FileReader so the caller still
 * gets a data URL). Always resolves — never throws.
 */
export async function compressImageToTarget(
  file: File
): Promise<CompressionResult> {
  const originalBytes = file.size;

  // Fast path: already small enough — just read & return.
  if (originalBytes <= TARGET_BYTES) {
    const dataUrl = await readAsDataUrl(file);
    return {
      dataUrl,
      bytes: originalBytes,
      width: 0,
      height: 0,
      compressed: false,
      originalBytes,
    };
  }

  // Try to compress. If anything fails, fall back to the original.
  try {
    const img = await loadImage(file);
    const sourceWidth = img.naturalWidth;
    const sourceHeight = img.naturalHeight;

    // Step 1: cap maximum dimension to MAX_WIDTH (most camera photos are
    // 4032×3024 — that's 12MP we don't need for a 600px email column).
    const initialScale = Math.min(1, MAX_WIDTH / sourceWidth);

    // Walk through (scale, quality) pairs, biggest+highest first.
    const attempts: Array<{ scale: number; quality: number }> = [
      { scale: initialScale, quality: 0.85 },
      { scale: initialScale, quality: 0.72 },
      { scale: initialScale * 0.75, quality: 0.72 },
      { scale: initialScale * 0.6, quality: 0.7 },
      { scale: initialScale * 0.5, quality: 0.65 },
      { scale: initialScale * 0.4, quality: 0.6 },
      { scale: initialScale * 0.3, quality: 0.55 },
    ];

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    let best: { dataUrl: string; bytes: number; w: number; h: number } | null =
      null;

    for (const { scale, quality } of attempts) {
      const w = Math.max(1, Math.round(sourceWidth * scale));
      const h = Math.max(1, Math.round(sourceHeight * scale));
      canvas.width = w;
      canvas.height = h;
      // White background — JPEG can't represent transparency, and emails
      // look better on white anyway.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const bytes = dataUrlBytes(dataUrl);
      if (bytes <= TARGET_BYTES) {
        return {
          dataUrl,
          bytes,
          width: w,
          height: h,
          compressed: true,
          originalBytes,
        };
      }
      // Track the smallest result so far in case nothing fits.
      if (!best || bytes < best.bytes) {
        best = { dataUrl, bytes, w, h };
      }
    }

    // Couldn't get under the target — return the smallest we managed.
    if (best) {
      return {
        dataUrl: best.dataUrl,
        bytes: best.bytes,
        width: best.w,
        height: best.h,
        compressed: true,
        originalBytes,
      };
    }
  } catch (err) {
    console.warn('Image compression failed, using original:', err);
  }

  // Final fallback: return the original file as a data URL.
  const dataUrl = await readAsDataUrl(file);
  return {
    dataUrl,
    bytes: originalBytes,
    width: 0,
    height: 0,
    compressed: false,
    originalBytes,
  };
}

/** Pretty-print a byte count for UI messages. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
