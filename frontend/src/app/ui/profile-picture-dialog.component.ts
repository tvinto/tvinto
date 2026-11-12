import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { PROFILE_ANIMALS, ProfileAnimal, ProfilePicture, animalFor } from '@shared/profilePicture';
import { DialogShellComponent } from './dialog-shell.component';
import { TPipe } from '../pipes/t.pipe';
import { TvNavigationService } from '../services/tv-navigation.service';
import { ToastService } from '../services/toast.service';
import { animalBackground, animalPicture } from '../utils/profile-face.utils';
import { pictureFromFile } from '../utils/picture-file.utils';
import { t } from '../utils/i18n';

/**
 * Choosing somebody's picture (2 November): the animal from their
 * name, one of the eight, or a picture of their own. Each is a round tile
 * that is a choice -- outlined and checked when chosen, as a chip is -- and
 * nothing changes until Save.
 *
 * A television has no files to choose from, so it offers the animals only; a
 * picture added on a phone or a computer shows there all the same.
 */
@Component({
  selector: 'app-profile-picture-dialog',
  standalone: true,
  imports: [DialogShellComponent, HlmButton, TPipe],
  template: `
    <app-dialog-shell [heading]="'avatar.title' | t" [wide]="true" (dismissed)="closed.emit()">
      <div class="picture-choices" role="radiogroup" [attr.aria-label]="'avatar.title' | t" data-picture-choices>
        <button
          type="button"
          class="picture-choice"
          role="radio"
          [attr.aria-checked]="chosen() === null"
          [attr.aria-label]="'avatar.fromName' | t"
          [attr.data-focus-first]="chosen() === null ? '' : null"
          data-picture-choice="name"
          (click)="chosen.set(null)"
        >
          <span class="picture-face" [style.background]="background(nameAnimal())">
            <img [src]="picture(nameAnimal())" alt="" draggable="false" />
          </span>
          <span class="picture-label">{{ 'avatar.fromName' | t }}</span>
        </button>
        @for (animal of animals; track animal) {
          <button
            type="button"
            class="picture-choice"
            role="radio"
            [attr.aria-checked]="chosen() === 'animal:' + animal"
            [attr.aria-label]="'avatar.animal.' + animal | t"
            [attr.data-focus-first]="chosen() === 'animal:' + animal ? '' : null"
            [attr.data-picture-choice]="animal"
            (click)="chosen.set('animal:' + animal)"
          >
            <span class="picture-face" [style.background]="background(animal)">
              <img [src]="picture(animal)" alt="" draggable="false" />
            </span>
            <span class="picture-label">{{ 'avatar.animal.' + animal | t }}</span>
          </button>
        }
        @if (own(); as mine) {
          <button
            type="button"
            class="picture-choice"
            role="radio"
            [attr.aria-checked]="chosen() === mine"
            [attr.aria-label]="'avatar.own' | t"
            [attr.data-focus-first]="chosen() === mine ? '' : null"
            data-picture-choice="own"
            (click)="chosen.set(mine)"
          >
            <span class="picture-face picture-face-own">
              <img [src]="mine" alt="" draggable="false" />
            </span>
            <span class="picture-label">{{ 'avatar.own' | t }}</span>
          </button>
        }
      </div>

      @if (!television) {
        <input #file type="file" accept="image/*" class="hidden" (change)="added($event)" data-picture-file />
      }

      @if (!television) {
        <button dialogActions hlmBtn type="button" [disabled]="reading()" (click)="file()?.nativeElement?.click()" data-picture-upload>
          {{ (reading() ? 'avatar.reading' : 'avatar.upload') | t }}
        </button>
      }
      <button dialogActions hlmBtn variant="quiet" type="button" (click)="closed.emit()">{{ 'common.cancel' | t }}</button>
      <button dialogActions hlmBtn variant="primary" type="button" [disabled]="saving() || reading()" (click)="saved.emit(chosen())" data-picture-save>
        {{ 'avatar.save' | t }}
      </button>
    </app-dialog-shell>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProfilePictureDialogComponent {
  /** Whose picture: the animal from the name is worked out from it. */
  readonly name = input.required<string>();
  /** What it is now. */
  readonly current = input<ProfilePicture | undefined>(null);
  /** While the choice is on its way to the service. */
  readonly saving = input(false);

  readonly saved = output<ProfilePicture>();
  readonly closed = output<void>();

  private readonly toast = inject(ToastService);
  readonly television = inject(TvNavigationService).isTelevision();

  readonly animals = PROFILE_ANIMALS;
  readonly chosen = linkedSignal<ProfilePicture>(() => this.current() ?? null);
  /** A picture of their own: the one they have, or one just added here. */
  readonly own = linkedSignal<string | null>(() => {
    const now = this.current();
    return now && !now.startsWith('animal:') ? now : null;
  });
  readonly reading = signal(false);
  readonly nameAnimal = computed(() => animalFor(this.name()));
  readonly file = viewChild<ElementRef<HTMLInputElement>>('file');

  picture(animal: ProfileAnimal): string {
    return animalPicture(animal);
  }

  background(animal: ProfileAnimal): string {
    return animalBackground(animal);
  }

  async added(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const chosenFile = input.files?.[0];
    input.value = '';
    if (!chosenFile) {
      return;
    }
    this.reading.set(true);
    try {
      const picture = await pictureFromFile(chosenFile);
      this.own.set(picture);
      this.chosen.set(picture);
    } catch {
      this.toast.error(t('avatar.failed'), t('avatar.unreadable'));
    } finally {
      this.reading.set(false);
    }
  }
}
