/**
 * When the wide layout applies: wide enough, and not truly short.
 *
 * A phone turned sideways is wide and short, and is turned sideways for the
 * guide -- so it gets the wide layout, and the short-screen rules in
 * styles.css slim the header and tab bar to pay for it. Tailwind's `md`
 * variant and those media queries use the same condition.
 */
export const WIDE_LAYOUT_QUERY = '(min-width: 768px) and (min-height: 380px)';

/**
 * Whether the wide layout applies right now.
 *
 * A television always counts, whatever its height. Android shrinks the WebView
 * to make room for the on-screen keyboard -- 960x540 to 960x300, measured --
 * and a set answering the query honestly at that moment would rearrange itself
 * into the phone layout for as long as somebody was typing. The `md` variant
 * in styles.css carries the same exemption for the same reason.
 */
export const wideLayoutNow = (): boolean =>
  typeof window !== 'undefined' &&
  (document.documentElement.classList.contains('tv') ||
    window.matchMedia(WIDE_LAYOUT_QUERY).matches);
