import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideSettings } from '@ng-icons/lucide';
import { BackButtonService } from '../services/back-button.service';
import { FocusScopeDirective } from '../directives/focus-scope.directive';
import { ChoicePanelService, PanelRequest } from './choice-panel.service';

/**
 * The panel itself (ChoicePanelService), mounted once beside the other
 * dialogs. Focus starts on the row that is on, so OK straight away changes
 * nothing; Back and the backdrop close it without changing anything, and
 * focus goes back to what opened it.
 */
@Component({
  selector: 'app-choice-panel',
  standalone: true,
  imports: [NgIcon, FocusScopeDirective],
  providers: [provideIcons({ lucideCheck, lucideSettings })],
  template: `
    @if (shown(); as request) {
      <div
        class="panel-screen"
        data-focus-scope
        data-choice-panel
        data-enter="sheet"
        role="dialog"
        aria-modal="true"
        [attr.aria-labelledby]="'panel-title-' + request.id"
        (click)="dismiss(request)"
      >
        <div class="panel" (click)="$event.stopPropagation()">
          <h2 class="panel-title" [id]="'panel-title-' + request.id">{{ request.title }}</h2>
          <div class="panel-rows" role="radiogroup" [attr.aria-labelledby]="'panel-title-' + request.id">
            @for (choice of request.choices; track $index) {
              <button
                type="button"
                class="choice-row"
                role="radio"
                [attr.aria-checked]="choice.value === request.value"
                [attr.data-focus-first]="choice.value === request.value ? '' : null"
                (click)="choose(request, choice.value)"
              >
                <!-- With pictures the one chosen is ringed, not checked. -->
                @if (!hasFaces(request)) {
                  <span class="choice-row-mark">
                    @if (choice.value === request.value) {
                      <ng-icon name="lucideCheck" aria-hidden="true" />
                    }
                  </span>
                }
                @if (choice.face; as face) {
                  @if (face === 'settings') {
                    <span class="choice-row-face choice-row-face-icon" aria-hidden="true"><ng-icon name="lucideSettings" /></span>
                  } @else {
                    <span class="choice-row-face" [style.background]="face.background" aria-hidden="true">
                      <img [src]="face.picture" alt="" [class.choice-row-face-own]="face.own" draggable="false" />
                    </span>
                  }
                }
                <span class="choice-row-label">{{ choice.label }}</span>
                @if (choice.detail) {
                  <span class="choice-row-detail">{{ choice.detail }}</span>
                }
              </button>
            }
          </div>
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChoicePanelComponent {
  private readonly panels = inject(ChoicePanelService);

  readonly shown = computed(() => this.panels.open());

  /** What had focus when the panel opened -- the row that opened it. */
  private returnTo: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const request = this.shown();
      untracked(() => {
        if (request && !this.returnTo) {
          const active = document.activeElement;
          this.returnTo = active instanceof HTMLElement && !active.closest('[data-choice-panel]') ? active : null;
        } else if (!request && this.returnTo) {
          const back = this.returnTo;
          this.returnTo = null;
          requestAnimationFrame(() => back.isConnected && back.focus({ preventScroll: true }));
        }
      });
    });

    inject(BackButtonService).bindTo(
      computed(() => this.shown() !== null),
      () => {
        const request = this.shown();
        if (request) {
          this.dismiss(request);
        }
      }
    );
  }

  hasFaces(request: PanelRequest): boolean {
    return request.choices.some(choice => choice.face);
  }

  choose(request: PanelRequest, value: unknown): void {
    this.panels.answer(request.id, { value });
  }

  dismiss(request: PanelRequest): void {
    this.panels.answer(request.id, null);
  }
}
