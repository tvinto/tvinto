import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { chooseServer } from './api-url';
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
