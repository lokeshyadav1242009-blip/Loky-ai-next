/**
 * LOKY AI Next — Android Back button / browser history controller.
 *
 * The app is a single page with (previously) no history entries of its own, so
 * one Back press left the page and the whole "app" appeared to vanish even
 * though a menu or a conversation was open.
 *
 * How this fixes it:
 *  - Every internal layer (menu, dialog, conversation, section) registers with
 *    `openLayer(name, close)`. Opening one pushes exactly one history entry.
 *  - Back pops that entry; the popstate handler closes the matching layer and
 *    nothing else, so Back never closes two things at once.
 *  - Closing a layer from the UI drops its entry again, so history never fills
 *    with dead entries and a later Back is never swallowed by a stale one.
 *  - At the root the first Back shows "Press back again to exit LOKY AI." and
 *    re-arms a sentinel entry so the page survives. A second Back inside the
 *    window is allowed to leave — the platform's normal exit gesture.
 *
 * The stack itself is DOM-free so it can be unit-tested with `node --test`.
 */

export const EXIT_HINT = 'Press back again to exit LOKY AI.';

/** How long the "press back again" confirmation stays valid. */
export const EXIT_WINDOW_MS = 2000;

const LAYER_STATE_KEY = 'lokyLayer';
const ROOT_STATE_KEY = 'lokyRoot';

/* -------------------------------------------------------------------------- */
/* Pure stack logic (no DOM, no history)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Create the layer stack + exit-confirmation state machine.
 *
 * @param {object}   [options]
 * @param {number}   [options.interval]  Confirmation window in milliseconds.
 * @param {Function} [options.now]       Clock, injectable for tests.
 */
export function createBackStack({ interval = EXIT_WINDOW_MS, now = () => Date.now() } = {}) {
  const layers = [];
  let lastHintAt = null;

  const indexOf = (name) => layers.findIndex((layer) => layer.name === name);

  return {
    size: () => layers.length,
    names: () => layers.map((layer) => layer.name),
    has: (name) => indexOf(name) !== -1,
    top: () => (layers.length ? layers[layers.length - 1] : null),

    /** Register (or move to the top) a layer. Re-opening is not a new layer. */
    push(name, close) {
      const existing = indexOf(name);
      if (existing !== -1) layers.splice(existing, 1);
      layers.push({ name, close });
    },

    remove(name) {
      const index = indexOf(name);
      if (index === -1) return false;
      layers.splice(index, 1);
      return true;
    },

    clear() {
      layers.length = 0;
      lastHintAt = null;
    },

    /**
     * Decide what a single Back press means right now.
     * Closes the top layer if there is one; otherwise confirms, then exits.
     */
    back() {
      if (layers.length) return { action: 'close', layer: layers.pop() };

      const stamp = now();
      if (lastHintAt !== null && stamp - lastHintAt <= interval) {
        lastHintAt = null;
        return { action: 'exit' };
      }

      lastHintAt = stamp;
      return { action: 'hint' };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Browser integration                                                        */
/* -------------------------------------------------------------------------- */

function createController({ onHint, interval = EXIT_WINDOW_MS, win = globalThis } = {}) {
  const stack = createBackStack({ interval });
  const history = win?.history;
  const canUseHistory = Boolean(history && typeof history.pushState === 'function');

  let armed = false; // the root sentinel entry is on the history stack
  let invoking = false; // we are closing a layer ourselves; ignore echoes
  let ignorePops = 0; // popstate events produced by our own history.back()

  function pushEntry(state) {
    if (!canUseHistory) return;
    try {
      history.pushState(state, '');
    } catch {
      /* Safari private mode / quota — the app still works, just without Back */
    }
  }

  function dropEntry() {
    if (!canUseHistory) return;
    ignorePops += 1;
    try {
      history.back();
    } catch {
      ignorePops -= 1;
    }
  }

  function arm() {
    if (armed || !canUseHistory) return;
    armed = true;
    pushEntry({ [ROOT_STATE_KEY]: true });
  }

  function open(name, close) {
    if (invoking) return;
    const already = stack.has(name);
    stack.push(name, close);
    if (!already && armed) pushEntry({ [LAYER_STATE_KEY]: name });
  }

  function closed(name) {
    if (invoking) return;
    const wasTop = stack.top()?.name === name;
    if (!stack.remove(name)) return;
    if (wasTop) dropEntry();
  }

  /** Close every layer (used on sign-out) without touching history entries. */
  function reset() {
    invoking = true;
    try {
      let layer;
      while ((layer = stack.back().layer)) layer.close?.();
    } finally {
      invoking = false;
    }
    stack.clear();

    // The current entry becomes the root again, so Back can never walk back
    // into a layer that belongs to the previous (signed-in) session.
    if (canUseHistory) {
      try {
        history.replaceState({ [ROOT_STATE_KEY]: true }, '');
      } catch {
        /* nothing to repair */
      }
    }
    armed = true;
  }

  function handlePopState() {
    if (ignorePops > 0) {
      ignorePops -= 1;
      return;
    }

    const decision = stack.back();

    if (decision.action === 'close') {
      invoking = true;
      try {
        decision.layer.close?.();
      } finally {
        invoking = false;
      }
      return;
    }

    if (decision.action === 'hint') {
      onHint?.(EXIT_HINT);
      // Stay in the app: the user must press Back once more to leave.
      pushEntry({ [ROOT_STATE_KEY]: true });
      return;
    }

    // Second Back inside the window — let the platform leave the page.
    stack.clear();
  }

  return { arm, open, closed, reset, handlePopState };
}

let active = null;

/**
 * Wire Back handling once. Safe to call before any layer exists.
 *
 * @param {object}   [options]
 * @param {Function} [options.onHint]  Renders the exit confirmation.
 */
export function initBackNav(options = {}) {
  if (active) return active;

  const win = options.win || globalThis;
  if (!win || typeof win.addEventListener !== 'function') return null;

  active = createController({ ...options, win });
  active.arm();
  win.addEventListener('popstate', active.handlePopState);
  return active;
}

/** A layer opened: menus, dialogs, an open conversation, another section. */
export function openLayer(name, close) {
  active?.open(name, close);
}

/** A layer was closed by the UI (button, scrim, Escape, route change). */
export function closeLayer(name) {
  active?.closed(name);
}

/** Drop every layer, e.g. after sign-out, so Back cannot restore them. */
export function resetLayers() {
  active?.reset();
}

export function isBackNavReady() {
  return Boolean(active);
}
