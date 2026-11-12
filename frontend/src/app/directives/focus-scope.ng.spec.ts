import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FocusScopeDirective } from './focus-scope.directive';

/**
 * A dialog taking focus as it opens.
 *
 * The fault this exists for was photographed on the television: the guide
 * picker open over half the screen, and the category list behind it still
 * wearing the focus ring. Nothing threw, nothing logged; the remote simply did
 * nothing useful until a press had been spent bringing focus in.
 */

@Component({
  standalone: true,
  imports: [FocusScopeDirective],
  template: `
    <button type="button" id="behind">Whatever opened it</button>

    @if (sheet()) {
      <div data-focus-scope>
        <input type="text" id="filter" />
        <button type="button" id="arrange">Arrange</button>
      </div>
    }

    @if (open()) {
      <div data-focus-scope>
        <button type="button" id="close">Close</button>
        @if (withList()) {
          <div data-focus-first>
            @if (empty()) {
              <p>Nothing here</p>
            } @else {
              <button type="button" id="first-row">First row</button>
              <button type="button" id="second-row">Second row</button>
            }
          </div>
        }
      </div>
    }
  `
})
class Host {
  readonly open = signal(false);
  readonly withList = signal(true);
  readonly empty = signal(false);
  readonly sheet = signal(false);
}

describe('FocusScopeDirective', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;

  const focusedId = (): string => (document.activeElement as HTMLElement).id;

  const openIt = async (): Promise<void> => {
    host.open.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [Host] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    host = fixture.componentInstance;

    // Somewhere to be taken from, which is the state the fault occurred in.
    (fixture.nativeElement.querySelector('#behind') as HTMLElement).focus();
  });

  it('takes focus off whatever opened it', async () => {
    expect(focusedId()).toBe('behind');

    await openIt();

    expect(focusedId()).not.toBe('behind');
  });

  // The phone's category sheet opened on its filter, and the keyboard came up
  // over the categories.
  it('does not start on a field that raises the keyboard', async () => {
    host.sheet.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(focusedId()).toBe('arrange');
  });

  it('starts where the dialog says to start', async () => {
    // Rather than on the close button in the header, which is what comes first
    // in the markup and is the one control nobody opened the dialog to press.
    await openIt();

    expect(focusedId()).toBe('first-row');
  });

  it('settles for the first thing it can reach when nothing is named', async () => {
    host.withList.set(false);

    await openIt();

    expect(focusedId()).toBe('close');
  });

  it('settles for it when the named place has nothing in it yet', async () => {
    // A list that is still loading, or a search that matched nothing.
    host.empty.set(true);

    await openIt();

    expect(focusedId()).toBe('close');
  });

  it('moves in when the list it was told about finally arrives', async () => {
    // The guide picker reads every guide on the account before it can list a
    // channel, so it opens with nothing focusable in it and the fallback lands
    // on the close button -- one press of OK from throwing the dialog away.
    host.empty.set(true);
    await openIt();
    expect(focusedId()).toBe('close');

    host.empty.set(false);
    fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(focusedId()).toBe('first-row');
  });

  it('does not move in once somebody has moved for themselves', async () => {
    // A press made while a list was loading is a decision. Taking focus out
    // from under it is this code overruling the person holding the remote.
    host.empty.set(true);
    await openIt();

    (fixture.nativeElement.querySelector('#behind') as HTMLElement).focus();

    host.empty.set(false);
    fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(focusedId()).toBe('behind');
  });

  it('leaves focus alone if the dialog has already placed it', async () => {
    // A dialog that focuses its own field on opening should keep it, rather
    // than being overruled by whichever control happens to come first.
    host.open.set(true);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('#second-row') as HTMLElement).focus();
    await fixture.whenStable();

    expect(focusedId()).toBe('second-row');
  });
});
