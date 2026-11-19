/**
 * LONG ANSWER PRESENTATION — pure decisions, testable in Node.
 *
 * A long answer is shown as a preview with an explicit toggle. Two rules matter
 * and both used to be broken:
 *
 *  1. The toggle must be a SIBLING of the clipped body. `overflow: hidden` on
 *     the body also clips anything appended inside it, which is how the old
 *     "Show full answer" button became invisible and unreachable.
 *  2. A reply must never be clipped while it is still streaming. The preview is
 *     only calculated once the stream has finished.
 */

import { isLongAnswer } from './rich-text.js';

export const EXPAND_LABEL = 'Show more';
export const COLLAPSE_LABEL = 'Show less';

/** Toggle label for the current state. */
export function expandLabel(expanded) {
  return expanded ? COLLAPSE_LABEL : EXPAND_LABEL;
}

/**
 * Stable per-answer key (content hash), so an expanded answer stays expanded
 * when history is re-rendered, after a refresh, or when the chat is reopened.
 */
export function answerKey(content) {
  const source = typeof content === 'string' ? content : '';
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  }
  return `${source.length}-${(hash >>> 0).toString(36)}`;
}

/**
 * What the renderer should do for one answer.
 *
 * `streaming` wins over length: a growing reply is always shown in full.
 */
export function decorateDecision(text, { streaming = false, expanded = false, threshold } = {}) {
  const source = typeof text === 'string' ? text : '';
  const collapse = !streaming && isLongAnswer(source, threshold);
  const isExpanded = collapse && expanded === true;
  return { collapse, expanded: isExpanded, label: expandLabel(isExpanded) };
}
