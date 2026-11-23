import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HlmButton } from '@spartan-ng/helm/button';
import { BackButtonService } from '../services/back-button.service';
import { TvNavigationService } from '../services/tv-navigation.service';
import { ChoiceChipsComponent, OrderChipsComponent, type Choice } from './choice-chips.component';
import { ChoicePanelComponent } from './choice-panel.component';
import { ChoicePanelService } from './choice-panel.service';
import { DialogShellComponent } from './dialog-shell.component';
import { PinPadComponent } from './pin-pad.component';
import { SettingGroupComponent, SettingRowComponent } from './setting-row.component';

/**
 * The pieces of round 14: what each is to the
 * remote, the keyboard and a screen reader, not how it looks -- the look is
 * checked on the television against the boards.
 */

/** Back, as the dialogs see it: the newest binding that is open is what a press closes. */
class FakeBack {
  private readonly bound: Array<{ open: () => boolean; dismiss: () => void }> = [];
  bindTo(open: () => boolean, dismiss: () => void): void {
    this.bound.push({ open, dismiss });
  }
  press(): void {
    [...this.bound].reverse().find(binding => binding.open())?.dismiss();
  }
}

const SIZES: readonly Choice<string>[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'larger', label: 'Larger' },
  { value: 'largest', label: 'Largest' }
];

@Component({
  standalone: true,
  imports: [ChoiceChipsComponent, OrderChipsComponent, SettingGroupComponent, SettingRowComponent, PinPadComponent, DialogShellComponent, HlmButton],
  template: `
    <app-choice-chips label="Display size" [choices]="sizes" [(value)]="size" />
    <app-order-chips label="Your languages" [choices]="languages" [(values)]="order" />
    <app-setting-group heading="Subtitles">
      <app-setting-row label="Show subtitles by themselves" kind="switch" [checked]="on()" (activate)="on.set(!on())" />
      <app-setting-row label="Subtitle language" value="Croatian" (activate)="opened = opened + 1" />
      <app-setting-row label="Locked" [disabled]="true" (activate)="opened = opened + 100" />
    </app-setting-group>
    <app-pin-pad [entered]="entered()" (digit)="digits.push($event)" (erase)="erased = erased + 1" />
    <button hlmBtn id="main" variant="primary" type="button">Main</button>
    <button hlmBtn id="quiet" variant="quiet" size="icon" type="button">Quiet</button>
    <button id="behind" type="button">Behind</button>
    @if (asking()) {
      <app-dialog-shell heading="Remove the guide?" message="Its programmes go." (dismissed)="asking.set(false)">
        <button dialogActions hlmBtn id="cancel" data-focus-first type="button">Cancel</button>
      </app-dialog-shell>
    }
  `
})
class Host {
  readonly sizes = SIZES;
  readonly languages: readonly Choice<string>[] = [
    { value: 'en', label: 'English' },
    { value: 'hr', label: 'Croatian' },
    { value: 'de', label: 'German' }
  ];
  readonly size = signal<string | null>('standard');
  readonly order = signal<readonly string[]>(['en']);
  readonly on = signal(false);
  readonly entered = signal(2);
  readonly asking = signal(false);
  opened = 0;
  erased = 0;
  readonly digits: string[] = [];
}

describe('the pieces', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let back: FakeBack;
  const all = (selector: string): HTMLElement[] => [...fixture.nativeElement.querySelectorAll(selector)] as HTMLElement[];
  const one = (selector: string): HTMLElement => fixture.nativeElement.querySelector(selector) as HTMLElement;

  beforeEach(() => {
    back = new FakeBack();
    TestBed.configureTestingModule({ imports: [Host], providers: [{ provide: BackButtonService, useValue: back }] });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('chips are a radio group with the one that is on checked', () => {
    const chips = all('[data-choice-chips] .chip');
    expect(one('[data-choice-chips]').getAttribute('role')).toBe('radiogroup');
    expect(chips.map(chip => chip.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    chips[2].click();
    fixture.detectChanges();
    expect(host.size()).toBe('largest');
    expect(all('[data-choice-chips] .chip').map(chip => chip.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
    expect(all('[data-choice-chips] .chip')[2].querySelector('ng-icon')).not.toBeNull();
  });

  it('ordered chips add at the end, take out, and show their place', () => {
    const chips = (): HTMLElement[] => all('[data-order-chips] .chip');
    chips()[2].click();
    fixture.detectChanges();
    expect(host.order()).toEqual(['en', 'de']);
    expect(chips().map(chip => chip.querySelector('[data-chip-place]')?.textContent ?? '')).toEqual(['1', '', '2']);
    chips()[0].click();
    fixture.detectChanges();
    expect(host.order()).toEqual(['de']);
    expect(chips()[2].getAttribute('aria-pressed')).toBe('true');
  });

  it('a switch row is the switch, and flips', () => {
    const row = one('app-setting-row .setting-row[role="switch"]');
    expect(row.getAttribute('aria-checked')).toBe('false');
    row.click();
    fixture.detectChanges();
    expect(row.getAttribute('aria-checked')).toBe('true');
  });

  it('a row that leads on says so, and an unavailable one keeps focus but does nothing', () => {
    const rows = all('app-setting-row button.setting-row');
    expect(rows[1].querySelector('.setting-row-value')?.textContent).toBe('Croatian');
    rows[1].click();
    rows[2].click();
    expect(host.opened).toBe(1);
    expect(rows[2].hasAttribute('disabled')).toBe(false);
    expect(rows[2].getAttribute('aria-disabled')).toBe('true');
    expect(one('.setting-group-title').textContent).toBe('Subtitles');
  });

  it('the PIN pad gives digits and a delete, with a dot for each given', () => {
    one('[data-pin-digit="7"]').click();
    one('[data-pin-digit="0"]').click();
    one('[data-pin-erase]').click();
    expect(host.digits).toEqual(['7', '0']);
    expect(host.erased).toBe(1);
    expect(all('.pin-dot-on').length).toBe(2);
    expect(all('.pin-dot').length).toBe(4);
  });

  it('the button is the pill: the main one solid, a quiet round one quiet', () => {
    expect(one('#main').className).toContain('pill');
    expect(one('#main').className).toContain('pill-primary');
    expect(one('#quiet').className).toContain('pill-quiet');
    expect(one('#quiet').className).toContain('pill-round');
  });

  it('a dialog takes focus, closes on Back and on the backdrop, and gives focus back', async () => {
    one('#behind').focus();
    host.asking.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    const screen = one('[data-dialog-shell]');
    expect(screen.getAttribute('role')).toBe('dialog');
    expect(screen.getAttribute('aria-labelledby')).toBe(one('.dialog-title').id);
    expect(document.activeElement?.id).toBe('cancel');

    back.press();
    fixture.detectChanges();
    expect(one('[data-dialog-shell]')).toBeNull();
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(document.activeElement?.id).toBe('behind');

    host.asking.set(true);
    fixture.detectChanges();
    one('[data-dialog-shell]').click();
    fixture.detectChanges();
    expect(host.asking()).toBe(false);
  });

  // A film TMDB could not open: the failure came as the page opened, with
  // nothing focused, and closing it left the television's focus on nothing.
  it('a dialog opened over nothing focused hands focus to the page when it goes', async () => {
    const content = jest.spyOn(TestBed.inject(TvNavigationService), 'focusContentWhenReady').mockImplementation(() => undefined);
    (document.activeElement as HTMLElement | null)?.blur();
    host.asking.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    back.press();
    fixture.detectChanges();
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(content).toHaveBeenCalled();
  });
});

@Component({
  standalone: true,
  imports: [ChoicePanelComponent],
  template: `<button id="row" type="button">Subtitle language</button><app-choice-panel />`
})
class PanelHost {}

describe('ChoicePanel', () => {
  let fixture: ComponentFixture<PanelHost>;
  let panels: ChoicePanelService;
  let back: FakeBack;
  const LANGUAGES = [
    { value: null, label: 'Off' },
    { value: 'hr', label: 'Croatian' },
    { value: 'en', label: 'English', detail: 'SDH' }
  ];

  beforeEach(() => {
    back = new FakeBack();
    TestBed.configureTestingModule({ imports: [PanelHost], providers: [{ provide: BackButtonService, useValue: back }] });
    fixture = TestBed.createComponent(PanelHost);
    panels = TestBed.inject(ChoicePanelService);
    fixture.detectChanges();
  });

  // The answer comes back wrapped: an async function returning a promise would
  // wait for the panel to be answered before handing it over.
  const open = async (): Promise<{ answer: Promise<{ value: string | null } | null> }> => {
    (fixture.nativeElement.querySelector('#row') as HTMLElement).focus();
    const answer = panels.choose('Subtitle language', LANGUAGES, 'hr');
    fixture.detectChanges();
    await fixture.whenStable();
    return { answer };
  };
  const rows = (): HTMLElement[] => [...fixture.nativeElement.querySelectorAll('[data-choice-panel] .choice-row')] as HTMLElement[];

  it('opens on the row that is on, and answers with the row chosen', async () => {
    const { answer } = await open();
    expect(rows().map(row => row.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows()[2].querySelector('.choice-row-detail')?.textContent).toBe('SDH');
    rows()[0].click();
    fixture.detectChanges();
    await expect(answer).resolves.toEqual({ value: null });
    expect(fixture.nativeElement.querySelector('[data-choice-panel]')).toBeNull();
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect((document.activeElement as HTMLElement).id).toBe('row');
  });

  it('Back and the backdrop answer nothing', async () => {
    const { answer: first } = await open();
    back.press();
    fixture.detectChanges();
    await expect(first).resolves.toBeNull();

    const { answer: second } = await open();
    (fixture.nativeElement.querySelector('[data-choice-panel]') as HTMLElement).click();
    fixture.detectChanges();
    await expect(second).resolves.toBeNull();
  });

  it('a panel asked for over another replaces it, and the first answers nothing', async () => {
    const { answer: first } = await open();
    const second = panels.choose('Audio language', LANGUAGES, 'en');
    fixture.detectChanges();
    await expect(first).resolves.toBeNull();
    expect(fixture.nativeElement.querySelector('.panel-title').textContent).toBe('Audio language');
    rows()[1].click();
    await expect(second).resolves.toEqual({ value: 'hr' });
  });
});
