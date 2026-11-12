import { Pipe, PipeTransform, inject } from '@angular/core';
import { shortProviderName } from '@shared/providers/providerRecord';
import { ProviderAccessService } from '../services/provider-access.service';

/**
 * `{{ stream.stream_id | providerName }}`: the name of the provider an item
 * came from, while more than one is switched on, and nothing otherwise -- with
 * one provider there is nothing to tell apart. Short:
 * a card's token, "bestplaylist" rather than "bestplaylist.example" (TV-25).
 *
 * Not pure, like `t`: the names change when a provider is added or renamed,
 * with nothing about the binding changing. The lookup is a map read.
 */
@Pipe({ name: 'providerName', standalone: true, pure: false })
export class ProviderNamePipe implements PipeTransform {
  private readonly access = inject(ProviderAccessService);

  transform(id: string | number | null | undefined): string {
    return id === null || id === undefined ? '' : shortProviderName(this.access.providerNameOf(id));
  }
}
