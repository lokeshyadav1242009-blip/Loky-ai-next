import test from 'node:test';
import assert from 'node:assert/strict';

import { validateChatRequest } from '../server/validate.js';
import { AppError } from '../server/errors.js';

const limits = { maxMessages: 10, maxInputChars: 100 };

/** Assert that fn throws an AppError with the expected status/code. */
function throwsAppError(fn, status, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof AppError, 'expected an AppError');
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test('accepts and trims a well-formed conversation', () => {
  const result = validateChatRequest(
    {
      messages: [
        { role: 'user', content: '  Hello  ' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
      ],
    },
    limits,
  );

  assert.deepEqual(result, [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' },
    { role: 'user', content: 'How are you?' },
  ]);
});

test('strips unknown fields so downstream code only sees role/content', () => {
  const result = validateChatRequest(
    {
      messages: [{ role: 'user', content: 'hi', evil: 'payload', __proto__: { polluted: true } }],
      extra: 'ignored',
    },
    limits,
  );

  assert.deepEqual(Object.keys(result[0]), ['role', 'content']);
  assert.deepEqual(result, [{ role: 'user', content: 'hi' }]);
});

test('collapses consecutive same-role messages', () => {
  const result = validateChatRequest(
    {
      messages: [
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
      ],
    },
    limits,
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].content, 'one\n\ntwo');
});

test('rejects a missing or malformed body', () => {
  throwsAppError(() => validateChatRequest(null, limits), 400, 'bad_request');
  throwsAppError(() => validateChatRequest([], limits), 400, 'bad_request');
  throwsAppError(() => validateChatRequest('hello', limits), 400, 'bad_request');
  throwsAppError(() => validateChatRequest({ messages: [] }, limits), 400, 'bad_request');
  throwsAppError(() => validateChatRequest({ messages: 'nope' }, limits), 400, 'bad_request');
});

test('rejects invalid roles and empty content', () => {
  throwsAppError(
    () => validateChatRequest({ messages: [{ role: 'system', content: 'x' }] }, limits),
    400,
    'bad_request',
  );
  throwsAppError(
    () => validateChatRequest({ messages: [{ role: 'user', content: '   ' }] }, limits),
    400,
    'bad_request',
  );
  throwsAppError(
    () => validateChatRequest({ messages: [{ role: 'user', content: 42 }] }, limits),
    400,
    'bad_request',
  );
});

test('requires the last message to come from the user', () => {
  throwsAppError(
    () =>
      validateChatRequest(
        {
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
          ],
        },
        limits,
      ),
    400,
    'bad_request',
  );
});

test('enforces the message count and size limits', () => {
  const tooMany = Array.from({ length: 11 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x',
  }));
  throwsAppError(() => validateChatRequest({ messages: tooMany }, limits), 400, 'bad_request');

  throwsAppError(
    () =>
      validateChatRequest(
        { messages: [{ role: 'user', content: 'y'.repeat(101) }] },
        limits,
      ),
    413,
    'payload_too_large',
  );
});
