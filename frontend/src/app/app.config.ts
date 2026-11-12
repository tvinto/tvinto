import { ApplicationConfig, inject, provideAppInitializer, provideZonelessChangeDetection } from '@angular/core';
import { LanguageService } from './services/language.service';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { sessionInterceptor } from './interceptors/session.interceptor';
import { setupHoldInterceptor } from './interceptors/setup-hold.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    // Without zone.js (10 October): Angular redraws when a signal a
    // view reads changes or an event reaches a template, and not after every
    // timer, scroll, worker message and native bridge answer anywhere in the
    // app -- which is what a television spent much of each key press on.
    // State a template shows belongs in a signal.
    provideZonelessChangeDetection(),
    provideRouter(routes),
    // The chosen language's words before the first screen is drawn (LanguageService.init).
    provideAppInitializer(() => inject(LanguageService).init()),
    provideHttpClient(withInterceptors([setupHoldInterceptor, sessionInterceptor]))
  ]
};
