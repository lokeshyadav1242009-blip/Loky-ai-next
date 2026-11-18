import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_SOURCE_BYTES,
  attachmentSummary,
  buildImagePayload,
  dataUrlToInline,
  formatMegabytes,
  hasImages,
  imageMimeFromName,
  mimeLabel,
  planDownscale,
  resolveImageType,
  selectImages,
  validateImageFile,
} from '../public/chat-images.js';

const file = (name, type, size = 2048) => ({ name, type, size });
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

test('accepts the four supported image types', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    const result = validateImageFile(file('photo', type));
    assert.equal(result.ok, true, `${type} should be accepted`);
    assert.equal(result.mimeType, type);
  }
  assert.deepEqual([...ALLOWED_IMAGE_TYPES].sort(), ['image/jpeg', 'image/png', 'image/webp']);
});

test('falls back to the file extension when the picker reports no type', () => {
  assert.equal(resolveImageType(file('holiday.JPG', '')), 'image/jpeg');
  assert.equal(resolveImageType(file('scan.jpeg', '')), 'image/jpeg');
  assert.equal(resolveImageType(file('diagram.png', '')), 'image/png');
  assert.equal(resolveImageType(file('notes.webp', '')), 'image/webp');
  assert.equal(imageMimeFromName('no-extension'), '');
});

test('rejects unsupported, oversized and empty files with a usable message', () => {
  const gif = validateImageFile(file('animation.gif', 'image/gif'));
  assert.equal(gif.ok, false);
  assert.equal(gif.code, 'unsupported_type');
  assert.match(gif.message, /not supported/i);
  assert.match(gif.message, /JPG, PNG or WEBP/);

  const huge = validateImageFile(file('huge.png', 'image/png', MAX_SOURCE_BYTES + 1));
  assert.equal(huge.ok, false);
  assert.equal(huge.code, 'too_large');

  const empty = validateImageFile(file('empty.png', 'image/png', 0));
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'empty_file');
});

test('selectImages caps a message at the per-message limit', () => {
  const files = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 2 }, (_, i) =>
    file(`shot-${i}.png`, 'image/png'),
  );
  const { accepted, errors } = selectImages(files, 0);
  assert.equal(accepted.length, MAX_IMAGES_PER_MESSAGE);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /up to 4 images/i);

  // Existing attachments count against the same cap.
  const partial = selectImages(files, 3);
  assert.equal(partial.accepted.length, 1);
  assert.equal(partial.errors.length, files.length - 1);
});

test('selectImages separates good files from bad ones', () => {
  const { accepted, errors } = selectImages(
    [file('good.png', 'image/png'), file('bad.pdf', 'application/pdf')],
    0,
  );
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].mimeType, 'image/png');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not supported/i);
});

test('planDownscale keeps small images and never upscales', () => {
  assert.deepEqual(planDownscale(800, 600), { width: 800, height: 600, scaled: false });
  const big = planDownscale(4000, 3000, 1400);
  assert.equal(big.scaled, true);
  assert.equal(Math.max(big.width, big.height), 1400);
  assert.ok(Math.abs(big.width / big.height - 4000 / 3000) < 0.01);
});

test('dataUrlToInline extracts the mime type and raw base64 bytes', () => {
  const inline = dataUrlToInline(PNG_DATA_URL);
  assert.equal(inline.mimeType, 'image/png');
  assert.ok(inline.data.length > 20);
  assert.equal(inline.data.includes('data:'), false);

  assert.equal(dataUrlToInline('data:text/plain;base64,aGVsbG8='), null);
  assert.equal(dataUrlToInline('iVBORw0KGgo='), null);
  assert.equal(dataUrlToInline(null), null);
});

test('buildImagePayload drops unusable entries and honours the cap', () => {
  const images = [
    { dataUrl: PNG_DATA_URL },
    { dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' },
    { dataUrl: PNG_DATA_URL },
  ];
  const payload = buildImagePayload(images);
  assert.equal(payload.length, 2);
  assert.ok(payload.every((image) => image.mimeType === 'image/png'));

  const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 3 }, () => ({ dataUrl: PNG_DATA_URL }));
  assert.equal(buildImagePayload(many).length, MAX_IMAGES_PER_MESSAGE);
  assert.deepEqual(buildImagePayload(undefined), []);
});

test('hasImages recognises legacy messages without an images field', () => {
  assert.equal(hasImages({ content: 'hello' }), false);
  assert.equal(hasImages({ content: '', images: [] }), false);
  assert.equal(hasImages({ content: '', images: [{ dataUrl: PNG_DATA_URL }] }), true);
  assert.equal(hasImages({ content: '', images: [{ dataUrl: 'data:text/plain;base64,QQ==' }] }), false);
});

test('labels are short and human readable', () => {
  assert.equal(mimeLabel('image/jpeg'), 'JPG');
  assert.equal(mimeLabel('image/webp'), 'WEBP');
  assert.equal(mimeLabel('image/gif'), 'IMG');
  assert.equal(attachmentSummary(0), '');
  assert.equal(attachmentSummary(1), '1 image attached');
  assert.equal(attachmentSummary(3), '3 images attached');
  assert.equal(formatMegabytes(8 * 1024 * 1024), '8.0 MB');
  assert.equal(formatMegabytes(2048), '2 KB');
});
