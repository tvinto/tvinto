import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { DesktopUpdateService } from '../../services/desktop-update.service';
import { AppUpdateService } from '../../services/app-update.service';
import { WebUpdateService } from '../../services/web-update.service';
import { TPipe } from '../../pipes/t.pipe';

/**
 * The bars that say an update is ready or on its way: the desktop's, the web
 * code's and the Android app's. In the shell, and on Welcome and Sign in too:
 * a device stuck before sign-in by a bug an update fixes could not see the
 * update that would fix it (24 November).
 */
@Component({
  selector: 'app-update-bars',
  standalone: true,
  imports: [TPipe, HlmButton],
  templateUrl: './update-bars.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UpdateBarsComponent {
  readonly update = inject(DesktopUpdateService);
  /** A newer Android app, offered for download. */
  readonly appUpdate = inject(AppUpdateService);
  /** This app's own code updating over the air, and restarting into it. */
  readonly webUpdate = inject(WebUpdateService);

  constructor() {
    // Both start once, wherever they are first shown.
    this.update.start();
    this.appUpdate.start();
  }
}
