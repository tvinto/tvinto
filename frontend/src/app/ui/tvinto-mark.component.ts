import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Tvinto's mark: the "i" of into with a play arrow for its dot, on the night
 * navy with an indigo rim (brand/, variant E1). Drawn here rather than loaded,
 * so it is there on the first frame. Sized by its host: `class="size-8"`.
 *
 * The shapes are brand/svg/tvinto-icon.svg's; change them there
 * (tools/brand/build-brand.js) and copy them across.
 */
@Component({
  selector: 'app-tvinto-mark',
  standalone: true,
  host: { class: 'inline-block shrink-0', 'aria-hidden': 'true' },
  template: `
    <svg viewBox="0 0 512 512" width="100%" height="100%" focusable="false">
      <rect width="512" height="512" rx="112.64" fill="#091426" />
      <rect x="9" y="9" width="494" height="494" rx="103.64" fill="none" stroke="#4c60dd" stroke-width="18" />
      <rect x="224" y="232" width="64" height="172" rx="32" fill="#ffffff" />
      <polygon points="217.9984,92 217.9984,196 308.4784,144" fill="#819cff" />
    </svg>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TvintoMarkComponent {}
