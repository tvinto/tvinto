import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TPipe } from '../../pipes/t.pipe';

/**
 * A poster covered because the age lock keeps its title closed (TV-31,
 * TV-26): the rating boxed, "Locked" beneath. Placed inside a poster's
 * positioned image box.
 */
@Component({
  selector: 'app-age-cover',
  standalone: true,
  imports: [TPipe],
  host: { class: 'absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/85', 'data-age-cover': '' },
  template: `
    <span class="rounded-sm border-2 border-foreground px-2.5 py-0.5 text-2xl font-extrabold" data-age-cover-rating>{{ rating() }}</span>
    <span class="text-sm text-muted-foreground">{{ 'lock.age.locked' | t }}</span>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AgeCoverComponent {
  readonly rating = input.required<string>();
}
