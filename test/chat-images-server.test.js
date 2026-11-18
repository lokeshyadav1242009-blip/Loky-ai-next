import test from 'node:test';
import assert from 'node:assert/strict';

import { validateChatRequest, validateImages } from '../server/validate.js';
import { buildGeminiParts, buildPayload } from '../server/providers.js';

const LIMITS = {
  maxMessages: 40,
  maxInputChars: 24000,
  maxImagesPerMessage: 4,
  maxImageBase64Chars: 2400000,
};

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const image = (mimeType = 'image/png', data = PNG_B64) => ({ mimeType, data });
const body = (...messages) => ({ messages });

test('an image-only message is accepted', () => {
  const out = validateChatRequest(body({ role: 'user', content: '', images: [image()] }), LIMITS);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, '');
  assert.deepEqual(out[0].images, [image()]);
});

test('a text + image message keeps both parts', () => {
  const out = validateChatRequest(
    body({ role: 'user', content: 'What is in this screenshot?', images: [image('image/jpeg')] }),
    LIMITS,
  );
  assert.equal(out[0].content, 'What is in this screenshot?');
  assert.equal(out[0].images.length, 1);
  assert.equal(out[0].images[0].mimeType, 'image/jpeg');
});

test('text-only messages keep working and gain no images field', () => {
  const out = validateChatRequest(body({ role: 'user', content: 'Hello' }), LIMITS);
  assert.equal(out[0].content, 'Hello');
  assert.equal('images' in out[0], false);
});

test('multiple images per message are allowed up to the limit', () => {
  const out = validateChatRequest(
    body({ role: 'user', content: 'Compare', images: [image(), image('image/jpeg'), image('image/webp')] }),
    LIMITS,
  );
  assert.equal(out[0].images.length, 3);

  const tooMany = Array.from({ length: 5 }, () => image());
  assert.throws(
    () => validateChatRequest(body({ role: 'user', content: 'x', images: tooMany }), LIMITS),
    /At most 4/,
  );
});

test('unsupported image types are rejected server-side', () => {
  assert.throws(
    () => validateChatRequest(body({ role: 'user', content: 'x', images: [image('image/gif')] }), LIMITS),
    /unsupported type/i,
  );
  assert.throws(
    () => validateChatRequest(body({ role: 'user', content: 'x', images: [image('text/html')] }), LIMITS),
    /unsupported type/i,
  );
});

test('a data: URL prefix is rejected — the provider needs raw base64', () => {
  assert.throws(
    () =>
      validateChatRequest(
        body({ role: 'user', content: 'x', images: [image('image/png', `data:image/png;base64,${PNG_B64}`)] }),
        LIMITS,
      ),
    /not valid base64/i,
  );
});

test('an empty message with no images is still rejected', () => {
  assert.throws(() => validateChatRequest(body({ role: 'user', content: '   ' }), LIMITS), /empty/i);
  assert.throws(() => validateChatRequest(body({ role: 'user', content: '', images: [] }), LIMITS), /empty/i);
});

test('consecutive user turns merge and keep their images', () => {
  const out = validateChatRequest(
    body({ role: 'user', content: 'first' }, { role: 'user', content: 'second', images: [image()] }),
    LIMITS,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'first\n\nsecond');
  assert.equal(out[0].images.length, 1);
});

test('validateImages returns a fresh sanitised array', () => {
  const raw = [image('IMAGE/PNG')];
  const out = validateImages(raw, LIMITS, 0);
  assert.equal(out[0].mimeType, 'image/png');
  assert.notEqual(out[0], raw[0]);
});

test('Gemini parts carry the real image bytes as inlineData', () => {
  const parts = buildGeminiParts({ content: 'Describe this', images: [image('image/jpeg')] });
  assert.deepEqual(parts[0], { text: 'Describe this' });
  assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/jpeg', data: PNG_B64 } });
});

test('an image-only turn produces inlineData and no empty text part', () => {
  const parts = buildGeminiParts({ content: '', images: [image()] });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].text, undefined);
  assert.equal(parts[0].inlineData.mimeType, 'image/png');
  assert.equal(parts[0].inlineData.data, PNG_B64);
});

test('the Gemini request body sends image bytes to the model', () => {
  const payload = buildPayload(
    {
      style: 'gemini',
      model: 'gemini-test',
      systemPrompt: 'You are LOKY AI.',
      temperature: 0.7,
      maxTokens: 100,
    },
    [{ role: 'user', content: '', images: [image()] }],
  );

  assert.equal(payload.contents.length, 1);
  assert.equal(payload.contents[0].role, 'user');
  const inline = payload.contents[0].parts.find((part) => part.inlineData);
  assert.ok(inline, 'inlineData part present');
  assert.equal(inline.inlineData.data, PNG_B64);
  assert.equal(payload.systemInstruction.parts[0].text, 'You are LOKY AI.');
});

test('the OpenAI-compatible body also forwards image content parts', () => {
  const payload = buildPayload(
    { style: 'openai', model: 'm', temperature: 0.2, maxTokens: 50 },
    [{ role: 'user', content: 'look', images: [image()] }],
  );
  const parts = payload.messages.at(-1).content;
  assert.ok(Array.isArray(parts), 'content becomes a parts array');
  assert.ok(parts.some((part) => part.type === 'image_url' || part.type === 'image'));
  assert.ok(parts.some((part) => part.type === 'text' && part.text === 'look'));
});
