import { Component, signal } from '@angular/core';
import { TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { SLOW_AFTER_MS, SlowWaitComponent, VERY_SLOW_AFTER_MS } from './slow-wait.component';

/**
 * A wait that says what it waits on once it is slow, counts, and past
 * twenty seconds says so and offers Try again (19 October).
 */
@Component({
  standalone: true,
  imports: [SlowWaitComponent],
  template: `<app-slow-wait [waiting]="waiting()" what="slow.episodes" [retryable]="true" (retry)="retried = retried + 1" />`
})
class Host {
  readonly waiting = signal(true);
  retried = 0;
}

describe('SlowWaitComponent', () => {
  const text = (fixture: { nativeElement: HTMLElement }) => fixture.nativeElement.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  it('says nothing at first, then what it waits on and for how long, then that it is too long', fakeAsync(() => {
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    // Drawn as signals change, as the zoneless app draws them.
    fixture.autoDetectChanges();
    tick(1000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-slow-wait]')).toBeNull();

    tick(SLOW_AFTER_MS);
    fixture.detectChanges();
    expect(text(fixture)).toMatch(/· 4 s$/);
    expect(fixture.nativeElement.querySelector('[data-slow-retry]')).toBeNull();

    tick(VERY_SLOW_AFTER_MS);
    fixture.detectChanges();
    tick(100);
    const retry = fixture.nativeElement.querySelector('[data-slow-retry]') as HTMLButtonElement;
    expect(retry).not.toBeNull();
    // Nothing else had focus, so the remote starts on Try again.
    expect(document.activeElement).toBe(retry);
    retry.click();
    expect(fixture.componentInstance.retried).toBe(1);

    fixture.componentInstance.waiting.set(false);
    fixture.detectChanges();
    tick(1000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-slow-wait]')).toBeNull();
    discardPeriodicTasks();
  }));
});
