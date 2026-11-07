import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackStack, EXIT_HINT, EXIT_WINDOW_MS } from '../public/back-nav.js';

/** Controllable clock so the exit window can be tested without waiting. */
function makeClock(start = 1000) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => {
    current += ms;
  };
  return now;
}

test('exit hint is the exact user-facing string', () => {
  assert.equal(EXIT_HINT, 'Press back again to exit LOKY AI.');
});

test('first Back at the root only warns, second Back exits', () => {
  const clock = makeClock();
  const stack = createBackStack({ now: clock });

  assert.deepEqual(stack.back(), { action: 'hint' });
  assert.deepEqual(stack.back(), { action: 'exit' });
});

test('the confirmation window expires, so a later Back warns again', () => {
  const clock = makeClock();
  const stack = createBackStack({ now: clock });

  assert.equal(stack.back().action, 'hint');
  clock.advance(EXIT_WINDOW_MS + 1);
  assert.equal(stack.back().action, 'hint');
  assert.equal(stack.back().action, 'exit');
});

test('a Back press inside the window exits, at the boundary it still exits', () => {
  const clock = makeClock();
  const stack = createBackStack({ now: clock });

  stack.back();
  clock.advance(EXIT_WINDOW_MS);
  assert.equal(stack.back().action, 'exit');
});

test('open layers are closed before the app ever considers exiting', () => {
  const clock = makeClock();
  const stack = createBackStack({ now: clock });
  const closed = [];

  stack.push('sidebar', () => closed.push('sidebar'));
  stack.push('about', () => closed.push('about'));

  const first = stack.back();
  assert.equal(first.action, 'close');
  assert.equal(first.layer.name, 'about');

  const second = stack.back();
  assert.equal(second.action, 'close');
  assert.equal(second.layer.name, 'sidebar');

  // Only now does the root behaviour apply.
  assert.equal(stack.back().action, 'hint');
  assert.equal(closed.length, 0, 'the stack reports the layer; the caller closes it');
});

test('layers close last-in-first-out', () => {
  const stack = createBackStack();
  stack.push('messages', () => {});
  stack.push('msg-thread', () => {});

  assert.deepEqual(stack.names(), ['messages', 'msg-thread']);
  assert.equal(stack.back().layer.name, 'msg-thread');
  assert.equal(stack.back().layer.name, 'messages');
  assert.equal(stack.size(), 0);
});

test('re-opening the same layer does not create a duplicate history entry', () => {
  const stack = createBackStack();
  stack.push('sidebar', () => {});
  stack.push('sidebar', () => {});

  assert.equal(stack.size(), 1);
  assert.deepEqual(stack.names(), ['sidebar']);
});

test('remove() drops only the named layer and reports whether it existed', () => {
  const stack = createBackStack();
  stack.push('messages', () => {});
  stack.push('msg-thread', () => {});

  assert.equal(stack.remove('messages'), true);
  assert.deepEqual(stack.names(), ['msg-thread']);
  assert.equal(stack.remove('messages'), false);
});

test('clear() forgets layers and the pending exit confirmation', () => {
  const clock = makeClock();
  const stack = createBackStack({ now: clock });

  stack.push('sidebar', () => {});
  assert.equal(stack.back().action, 'hint');
  assert.equal(stack.back().action, 'exit');

  stack.clear();
  assert.equal(stack.size(), 0);
  // A fresh hint is required after a reset (e.g. sign-out).
  assert.equal(stack.back().action, 'hint');
});

test('exit resets the confirmation so the next Back warns again', () => {
  const clock = makeClock();
  const stack = createBackStack({ now: clock });

  assert.equal(stack.back().action, 'hint');
  assert.equal(stack.back().action, 'exit');
  assert.equal(stack.back().action, 'hint');
});

test('a non-top layer being closed leaves the top layer intact', () => {
  const stack = createBackStack();
  stack.push('messages', () => {});
  stack.push('msg-thread', () => {});

  stack.remove('messages');
  assert.deepEqual(stack.names(), ['msg-thread']);
  assert.equal(stack.back().layer.name, 'msg-thread');
});
