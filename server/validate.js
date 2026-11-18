import { errors } from './errors.js';

const ALLOWED_ROLES = new Set(['user', 'assistant']);

/** Inline image types the provider accepts (Gemini inlineData / OpenAI image_url). */
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const maxImages = (limits) => limits?.maxImagesPerMessage ?? 4;
const maxImageChars = (limits) => limits?.maxImageBase64Chars ?? 2400000;

/**
 * Validate the optional `images` array of one message.
 *
 * Only base64 bytes with an allow-listed image MIME type are accepted, so the
 * provider can never be handed a URL, an HTML payload or an unsupported format.
 * Returns a fresh array of { mimeType, data }.
 */
export function validateImages(raw, limits, messageIndex = 0) {
  if (raw == null) return [];
  const label = `Message ${messageIndex + 1}`;
  if (!Array.isArray(raw)) {
    throw errors.badRequest(`${label} has an invalid "images" value.`);
  }
  const limit = maxImages(limits);
  if (raw.length > limit) {
    throw errors.badRequest(
      `${label} has ${raw.length} images. At most ${limit} can be attached to one message.`,
      'Remove a few images and try again.',
    );
  }

  return raw.map((image, index) => {
    const position = `${label}, image ${index + 1}`;
    if (!image || typeof image !== 'object') {
      throw errors.badRequest(`${position} is not a valid image object.`);
    }
    const mimeType = String(image.mimeType ?? '').toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mimeType)) {
      throw errors.badRequest(
        `${position} has an unsupported type.`,
        'Only JPG, PNG and WEBP images are supported.',
      );
    }
    const data = typeof image.data === 'string' ? image.data.replace(/\s+/g, '') : '';
    if (!data) {
      throw errors.badRequest(`${position} has no image data.`);
    }
    if (!BASE64_PATTERN.test(data)) {
      throw errors.badRequest(
        `${position} is not valid base64 image data.`,
        'Send the raw file bytes base64-encoded, without a data: prefix.',
      );
    }
    if (data.length > maxImageChars(limits)) {
      throw errors.tooLarge(
        `${position} is too large.`,
        'Downscale the image to under about 2 MB and try again.',
      );
    }
    return { mimeType, data };
  });
}

/**
 * Validate and normalise the chat request body.
 *
 * Accepted shape:
 *   { messages: [{ role: 'user' | 'assistant', content: '...' }, ...] }
 *
 * Returns a fresh array (never the raw request object) so downstream code only
 * ever sees well-formed data: no extra fields, no prototype pollution, bounded
 * length, alternating-safe roles, last message always from the user.
 */
export function validateChatRequest(body, limits) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw errors.badRequest('Send a JSON object with a "messages" array.');
  }

  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw errors.badRequest('The "messages" array is empty.');
  }
  if (messages.length > limits.maxMessages) {
    throw errors.badRequest(
      `This conversation is too long (${messages.length} messages). Start a new chat to continue.`,
      `The server accepts at most ${limits.maxMessages} messages per request.`,
    );
  }

  const cleaned = [];
  let totalChars = 0;

  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== 'object') {
      throw errors.badRequest(`Message ${index + 1} is not a valid object.`);
    }
    const role = message.role;
    if (!ALLOWED_ROLES.has(role)) {
      throw errors.badRequest(
        `Message ${index + 1} has an invalid role. Use "user" or "assistant".`,
      );
    }
    if (typeof message.content !== 'string') {
      throw errors.badRequest(`Message ${index + 1} must have string content.`);
    }
    const content = message.content.trim();
    // An image-only message is legitimate: the pictures carry the question.
    const images = validateImages(message.images, limits, index);
    if (!content && images.length === 0) {
      throw errors.badRequest(`Message ${index + 1} is empty.`);
    }

    totalChars += content.length;
    if (totalChars > limits.maxInputChars) {
      throw errors.tooLarge(
        `Your message history is too long (${totalChars.toLocaleString()} characters, limit ${limits.maxInputChars.toLocaleString()}).`,
        'Start a new conversation, or shorten your message.',
      );
    }

    // Collapse consecutive same-role messages; some providers reject them.
    const last = cleaned[cleaned.length - 1];
    if (last && last.role === role) {
      last.content = last.content ? `${last.content}\n\n${content}` : content;
      if (images.length) {
        last.images = [...(last.images ?? []), ...images].slice(0, maxImages(limits));
      }
    } else {
      cleaned.push(images.length ? { role, content, images } : { role, content });
    }
  }

  if (cleaned[cleaned.length - 1].role !== 'user') {
    throw errors.badRequest('The last message must come from the user.');
  }

  return cleaned;
}

/** Truncate a value for safe logging (no newlines, bounded length). */
export function logValue(value, max = 120) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
