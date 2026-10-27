import { errors } from './errors.js';

const ALLOWED_ROLES = new Set(['user', 'assistant']);

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
    if (!content) {
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
      last.content = `${last.content}\n\n${content}`;
    } else {
      cleaned.push({ role, content });
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
