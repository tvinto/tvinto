import { TestBed } from '@angular/core/testing';
import { ToastService } from './toast.service';

describe('ToastService', () => {
  let toasts: ToastService;

  beforeEach(() => {
    jest.useFakeTimers();
    TestBed.resetTestingModule();
    toasts = TestBed.inject(ToastService);
  });

  afterEach(() => jest.useRealTimers());

  describe('a failure', () => {
    it('waits in the error dialog until it is closed, not in a toast that goes by itself', () => {
      toasts.error("Couldn't load this category", 'Your provider did not answer.', { detail: 'HTTP 502' });

      jest.advanceTimersByTime(60_000);
      expect(toasts.toasts()).toEqual([]);
      expect(toasts.problems()).toEqual([
        expect.objectContaining({ title: "Couldn't load this category", detail: 'HTTP 502' })
      ]);

      toasts.closeProblem(toasts.problems()[0].id);
      expect(toasts.problems()).toEqual([]);
    });

    // A category that fails on every retry should not stack identical dialogs.
    it('is said once, however often it happens before it is closed', () => {
      toasts.error('Same', 'thing');
      toasts.error('Same', 'thing');

      expect(toasts.problems()).toHaveLength(1);
    });

    it('keeps what it offers to do', () => {
      const run = jest.fn();
      toasts.error("This device can't play 4K", undefined, { action: { label: 'Play that version', run } });

      toasts.problems()[0].action?.run();
      expect(run).toHaveBeenCalled();
    });
  });

  it('keeps no more than three toasts on screen, dropping the oldest', () => {
    for (const title of ['one', 'two', 'three', 'four']) {
      toasts.info(title);
    }

    expect(toasts.toasts().map(toast => toast.title)).toEqual(['two', 'three', 'four']);
  });

  it('takes a toast away by itself', () => {
    toasts.info('Saved');

    jest.advanceTimersByTime(7000);
    expect(toasts.toasts()).toEqual([]);
  });
});
