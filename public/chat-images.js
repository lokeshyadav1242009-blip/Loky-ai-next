/**
 * LOKY AI Next — image attachment rules for the AI Assistant composer.
 *
 * Pure module: no DOM, no network, no storage. Everything here is a plain
 * function so the rules can be unit tested in node and reused by the browser
 * (public/app.js) without duplicating limits in two places.
 *
 * The same numbers are enforced again on the server (server/validate.js):
 * the browser rules exist for instant feedback, the server rules are the
 * ones that actually protect the provider call.
 */

/** Image types Gemini accepts inline (jpg/jpeg/png/webp, per the product spec). */
export const ALLOWED_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

/** Extension fallback: some Android pickers report an empty file.type. */
export const IMAGE_EXTENSIONS = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
});

export const MAX_IMAGES_PER_MESSAGE = 4;
/** Largest source file we will accept before downscaling. */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
/** Longest base64 data URL we will keep after downscaling (~1.9 MB). */
export const MAX_PAYLOAD_CHARS = 1900000;
/** Longest edge in CSS pixels after downscaling — plenty for OCR/diagrams. */
export const MAX_EDGE = 1400;

const MIME_LABEL = { 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WEBP' };

export function extensionOf(name) {
  const text = String(name ?? '');
  const dot = text.lastIndexOf('.');
  return dot === -1 ? '' : text.slice(dot + 1).toLowerCase();
}

/** MIME type inferred from the file name, or '' when the extension is unknown. */
export function imageMimeFromName(name) {
  return IMAGE_EXTENSIONS[extensionOf(name)] ?? '';
}

/** Prefer the reported MIME type, fall back to the extension. */
export function resolveImageType(file) {
  const reported = String(file?.type ?? '').toLowerCase();
  if (ALLOWED_IMAGE_TYPES.includes(reported)) return reported;
  return imageMimeFromName(file?.name);
}

/**
 * Validate one picked/dropped/pasted file.
 * @returns {{ok: true, mimeType: string} | {ok: false, code: string, message: string}}
 */
export function validateImageFile(file) {
  if (!file || typeof file !== 'object') {
    return { ok: false, code: 'not_a_file', message: 'That item is not an image file.' };
  }
  const mimeType = resolveImageType(file);
  if (!mimeType) {
    const label = extensionOf(file.name).toUpperCase();
    return {
      ok: false,
      code: 'unsupported_type',
      message: label
        ? `.${label.toLowerCase()} files are not supported. Use JPG, PNG or WEBP.`
        : 'That file type is not supported. Use JPG, PNG or WEBP.',
    };
  }
  if (Number(file.size) > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      code: 'too_large',
      message: `${file.name || 'That image'} is ${formatMegabytes(file.size)}. The limit is ${formatMegabytes(
        MAX_SOURCE_BYTES,
      )}.`,
    };
  }
  if (Number(file.size) === 0) {
    return { ok: false, code: 'empty_file', message: 'That image is empty (0 bytes).' };
  }
  return { ok: true, mimeType };
}

/**
 * Split a FileList/array into accepted files and user-facing errors, honouring
 * the per-message cap.
 * @param {ArrayLike<File>} files
 * @param {number} existingCount images already attached
 */
export function selectImages(files, existingCount = 0) {
  const list = Array.from(files ?? []);
  const accepted = [];
  const errors = [];
  let room = Math.max(0, MAX_IMAGES_PER_MESSAGE - Math.max(0, existingCount));

  for (const file of list) {
    const result = validateImageFile(file);
    if (!result.ok) {
      errors.push(result.message);
      continue;
    }
    if (room === 0) {
      errors.push(`You can attach up to ${MAX_IMAGES_PER_MESSAGE} images per message.`);
      continue;
    }
    accepted.push({ file, mimeType: result.mimeType });
    room -= 1;
  }

  return { accepted, errors };
}

/** Downscale plan for a bitmap: keeps aspect ratio, never upscales. */
export function planDownscale(width, height, maxEdge = MAX_EDGE) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const longest = Math.max(w, h);
  if (!longest || longest <= maxEdge) return { width: w, height: h, scaled: false };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
    scaled: true,
  };
}

/** Split a data URL into the {mimeType, data} pair Gemini expects inline. */
export function dataUrlToInline(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/** Convert attached images into the request payload (invalid ones dropped). */
export function buildImagePayload(images) {
  if (!Array.isArray(images)) return [];
  return images
    .map((image) => dataUrlToInline(image?.dataUrl))
    .filter(Boolean)
    .slice(0, MAX_IMAGES_PER_MESSAGE);
}

/** Human label for the attachment count ("1 image", "3 images"). */
export function attachmentSummary(count) {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  return n === 1 ? '1 image attached' : `${n} images attached`;
}

/** Short label used on the message bubble ("JPG", "PNG", "WEBP"). */
export function mimeLabel(mimeType) {
  return MIME_LABEL[String(mimeType ?? '').toLowerCase()] ?? 'IMG';
}

export function formatMegabytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

/**
 * True when the stored message still carries at least one usable image.
 * History written by older versions has no `images` field at all.
 */
export function hasImages(message) {
  return Array.isArray(message?.images) && message.images.some((img) => dataUrlToInline(img?.dataUrl));
}
