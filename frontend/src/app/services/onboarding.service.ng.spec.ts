import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AccountService } from './account.service';
import { GuideService } from './guide.service';
import { GuideSourcesService } from './guide-sources.service';
import { OnboardingService } from './onboarding.service';

/** The first launch's walk-through: who sees it, once, and what follows signing in from it. */
describe('OnboardingService', () => {
  const local = signal(true);
  const hasSubscription = signal(false);
  const loading = signal<object | null>(null);
  const added: string[] = [];
  const loaded: string[] = [];

  const setup = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: AccountService, useValue: { localProfile: { active: local }, hasSubscription } },
        {
          provide: GuideService,
          useValue: {
            isLoading: () => loading() !== null,
            load: async (id: string) => {
              loaded.push(id);
              return {};
            }
          }
        },
        { provide: GuideSourcesService, useValue: { add: (url: string) => added.push(url) } }
      ]
    });
    return TestBed.inject(OnboardingService);
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    local.set(true);
    hasSubscription.set(false);
    loading.set(null);
    added.length = 0;
    loaded.length = 0;
  });

  it('is shown on a device with no account and nothing to watch, once', () => {
    const onboarding = setup();
    expect(onboarding.shouldShow()).toBe(true);

    onboarding.finish();

    expect(onboarding.shouldShow()).toBe(false);
  });

  it('is not shown to a device that has a provider', () => {
    const onboarding = setup();
    hasSubscription.set(true);
    expect(onboarding.shouldShow()).toBe(false);
  });

  it('is shown to a brand-new account with nothing to watch, as to a device without one (card 42)', () => {
    const onboarding = setup();
    local.set(false);
    expect(onboarding.shouldShow()).toBe(true);

    onboarding.finish();
    expect(onboarding.shouldShow()).toBe(false);
  });

  it('downloads a guide added here only once the one before it has finished', async () => {
    jest.useFakeTimers();
    try {
      const onboarding = setup();
      loading.set({ sourceId: 'provider' });

      onboarding.addGuide('https://epg.example/hr.xml.gz', 'Example');
      expect(added).toEqual(['https://epg.example/hr.xml.gz']);
      await jest.advanceTimersByTimeAsync(3000);
      expect(loaded).toEqual([]);

      loading.set(null);
      await jest.advanceTimersByTimeAsync(1500);
      expect(loaded).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
