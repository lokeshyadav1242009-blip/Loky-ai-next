/**
 * LOKY AI NEXT — which screen is visible for a given section.
 *
 * Pure and DOM-free so the Memory black-screen regression can be asserted
 * directly instead of by inspecting CSS by eye.
 *
 * History: the Memory section shipped with a permanent `hidden` attribute and
 * nothing ever removed it — `setSection()` only hid #appShell. Whether the page
 * appeared at all was decided by whether `.memory { display: block }` in
 * upgrade.css had loaded (an author rule beats the UA `[hidden]` rule). When it
 * had not, #appShell and #memory were both display:none: a blank black screen.
 * Visibility is now computed here and applied explicitly to every section.
 */

export const SECTIONS = ['assistant', 'messages', 'memory'];

/** Anything unrecognised falls back to the assistant, never to nothing. */
export function normaliseSection(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return SECTIONS.includes(raw) ? raw : 'assistant';
}

/**
 * @returns {{ assistant: boolean, messages: boolean, memory: boolean }}
 *          exactly one screen is true, so at least one surface is always shown
 */
export function sectionVisibility(section) {
  const active = normaliseSection(section);
  return {
    assistant: active === 'assistant',
    messages: active === 'messages',
    memory: active === 'memory',
  };
}
