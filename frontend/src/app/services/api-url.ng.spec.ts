import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { chooseServer, movedApiUrl } from './api-url';
import { ServiceKindService } from './service-kind.service';

/**
 * A server chosen at sign-in is used at once, by services that already exist.
 *
 * The address used to be read once, as the app started, so choosing a server
 * restarted the app -- which came back on Welcome with the name typed gone
 * (12 November). Now each request asks for it.
 */
describe('the server address, read at each use', () => {
  const asked: string[] = [];

  beforeEach(() => {
    asked.length = 0;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: HttpClient,
          useValue: {
            get: (url: string) => {
              asked.push(url);
              return of({ success: true, data: { service: 'sync' } });
            }
          }
        }
      ]
    });
  });

  afterEach(() => chooseServer(null));

  it('follows a server chosen after the service was made', async () => {
    chooseServer('https://first.example/api');
    const kind = TestBed.inject(ServiceKindService);
    await kind.isSyncService();

    chooseServer('https://second.example/api');
    kind.forget();
    await kind.isSyncService();

    expect(asked).toEqual(['https://first.example/api/health', 'https://second.example/api/health']);
  });
});

// Chromium drops Authorization on a redirect to another origin: a server kept
// as http:// that answers from https:// signed in, then refused everything (24 November).
describe('a server answering from another address', () => {
  it('is kept at the address it answered from', () => {
    expect(movedApiUrl({ redirected: true, url: 'https://sync.example.app/api/health' })).toBe('https://sync.example.app/api');
  });

  it('is left alone when it answered where it was asked', () => {
    expect(movedApiUrl({ redirected: false, url: 'https://sync.example.app/api/health' })).toBeNull();
  });

  it('is left alone when the redirect went somewhere that is not its health', () => {
    expect(movedApiUrl({ redirected: true, url: 'https://sync.example.app/login' })).toBeNull();
  });
});
