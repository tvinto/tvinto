import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SettingGroupComponent, SettingRowComponent } from '../../ui/setting-row.component';
import { ErrorReportsService } from '../../services/error-reports.service';
import { TPipe } from '../../pipes/t.pipe';

/**
 * "Send error reports" (docs/error-reports.md), with what is sent. Account-
 * wide, like the other settings here. Shown only in a build that can send
 * reports: a fork or a self-build has nothing to switch.
 */
@Component({
  selector: 'app-error-report-settings',
  standalone: true,
  imports: [TPipe, SettingGroupComponent, SettingRowComponent],
  host: { class: 'contents' },
  template: `
    @if (reports.available) {
      <app-setting-group [heading]="'errorReports.heading' | t" data-error-report-settings>
        <app-setting-row
          [label]="'errorReports.title' | t"
          [sub]="'errorReports.body' | t"
          kind="switch"
          [checked]="reports.on()"
          focusKey="error-reports-on"
          (activate)="toggle()"
        />
      </app-setting-group>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ErrorReportSettingsComponent {
  readonly reports = inject(ErrorReportsService);

  toggle(): void {
    this.reports.setOn(!this.reports.on());
    // Changed here, so it has been seen here.
    this.reports.markShown();
  }
}
