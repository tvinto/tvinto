import { readFileSync } from 'fs';
import { join } from 'path';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UpdateBarsComponent } from './update-bars.component';
import { DesktopUpdateService } from '../../services/desktop-update.service';
import { AppUpdateService } from '../../services/app-update.service';
import { WebUpdateService } from '../../services/web-update.service';

/** The update bars, which a device stuck before sign-in could not see (24 November). */
describe('UpdateBarsComponent', () => {
  function bars(desktop: { ready: string | null }, apk: { version: string } | null = null) {
    const update = {
      ready: signal(desktop.ready),
      dismissed: signal(false),
      installing: signal(false),
      start: jest.fn(),
      restart: jest.fn(),
      later() {
        this.dismissed.set(true);
      }
    };
    const appUpdate = {
      start: jest.fn(),
      showing: signal(apk !== null),
      available: signal(apk),
      phase: signal('idle'),
      percent: signal(0),
      size: signal(''),
      shortLink: signal(''),
      message: signal(''),
      holdsBackWebUpdate: signal(apk !== null),
      later: jest.fn(),
      download: jest.fn(),
      install: jest.fn()
    };
    const webUpdate = { downloading: signal(null), waiting: signal(null), dismissed: signal(false), restarting: signal(false), restart: jest.fn(), later: jest.fn() };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopUpdateService, useValue: update },
        { provide: AppUpdateService, useValue: appUpdate },
        { provide: WebUpdateService, useValue: webUpdate }
      ]
    });
    const fixture = TestBed.createComponent(UpdateBarsComponent);
    fixture.detectChanges();
    return { fixture, update, appUpdate, text: () => (fixture.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ').trim() ?? '' };
  }

  it("shows the desktop's ready update with Restart now and Later, and Later hides it", () => {
    const { fixture, update, appUpdate, text } = bars({ ready: '1.0.130' });
    expect(update.start).toHaveBeenCalled();
    expect(appUpdate.start).toHaveBeenCalled();
    expect(text()).toContain('1.0.130');
    const buttons = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    buttons[0].click();
    expect(update.restart).toHaveBeenCalled();
    buttons[1].click();
    fixture.detectChanges();
    expect(text()).toBe('');
  });

  it('shows a newer Android app', () => {
    const { fixture } = bars({ ready: null }, { version: '1.0.60' });
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-app-update]')?.textContent).toContain('1.0.60');
  });

  it('shows nothing with no update', () => {
    expect(bars({ ready: null }).text()).toBe('');
  });

  // Welcome and Sign in are outside the shell, which is where the bars were.
  it.each([
    ['Welcome', '../onboarding/onboarding.component'],
    ['Sign in', '../login/login.component'],
    ['the shell', '../shell/shell.component']
  ])('is on %s', (_page, file) => {
    expect(readFileSync(join(__dirname, `${file}.html`), 'utf8')).toContain('<app-update-bars />');
    expect(readFileSync(join(__dirname, `${file}.ts`), 'utf8')).toMatch(/imports: \[[^\]]*UpdateBarsComponent/);
  });
});
