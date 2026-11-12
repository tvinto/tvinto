import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal, output, input } from '@angular/core';
import { channelDisplay } from '../../utils/channel-display.utils';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideCheck, lucideSearch, lucideX } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { Stream } from '@shared/types';
import { KnownChannel } from '@shared/xtream/guide';
import {
  ChannelSuggestion,
  searchWithoutProviderNoise,
  suggestGuideChannels
} from '@shared/xtream/guideSuggestions';
import { indexGuideChannels, resolveGuideChannel } from '@shared/xtream/guideMatching';
import { GuideService } from '../../services/guide.service';
import { GuideSourcesService, guideName } from '../../services/guide-sources.service';
import { FocusScopeDirective } from '../../directives/focus-scope.directive';
import { t } from '../../utils/i18n';
import { TPipe } from '../../pipes/t.pipe';

/**
 * Choosing which guide channel describes a stream.
 *
 * For where automatic matching cannot reach, which is not an edge: nearly half
 * a real line-up carries no channel id at all, and plenty of the rest carry
 * one no feed has heard of.
 *
 * Suggestions first, because the person opening this already knows which
 * channel they meant and the list only has to put it near the top. Search and
 * the source filter are for when it does not.
 */
@Component({
  selector: 'app-channel-guide-picker',
  standalone: true,
  imports: [TPipe, ReactiveFormsModule, NgIcon, HlmButton, HlmInput, FocusScopeDirective],
  providers: [provideIcons({ lucideArrowLeft, lucideCheck, lucideSearch, lucideX })],
  templateUrl: './channel-guide-picker.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChannelGuidePickerComponent implements OnInit {
  readonly stream = input.required<Stream>();
  readonly closed = output<void>();
  /** Raised when the mapping changed, so the list behind can redraw. */
  readonly changed = output<void>();

  private readonly guide = inject(GuideService);
  readonly sources = inject(GuideSourcesService);
  readonly guideName = guideName;

  readonly search = new FormControl('', { nonNullable: true });
  readonly suggestions = signal<ChannelSuggestion[]>([]);
  readonly loading = signal(true);

  /** Which sources to look in. Empty means all of them. */
  readonly chosenSources = signal<string[]>([]);

  /**
   * The search worth offering when this one found nothing.
   *
   * Empty unless there is genuinely a way out: the repaired text has to differ
   * from what was typed *and* actually turn something up. A button saying
   * "search X instead" that leads to a second empty screen is worse than no
   * button, because it spends the one press someone had left.
   */
  readonly rescue = signal<string>('');

  private channels: KnownChannel[] = [];

  /**
   * The guide channel in force right now, and how it got there.
   *
   * Shown because otherwise the list gives no way to tell which of forty
   * plausible rows is the one already being used -- and changing something you
   * cannot see is guesswork. Automatic counts: a match nobody chose is still
   * the match in force.
   */
  readonly current = signal<{ channel: KnownChannel; byHand: boolean } | null>(null);

  async ngOnInit(): Promise<void> {
    this.streamName.set(this.stream().name);
    this.channels = await this.guide.allChannels();
    this.channelCount.set(this.channels.length);
    this.current.set(this.whatIsInForce());
    this.loading.set(false);
    this.refresh();

    this.search.valueChanges.subscribe(() => this.refresh());
  }

  /** The mapping in force, if this stream has been matched by hand. */
  get mapping() {
    return this.sources.mappingFor(this.stream().stream_id);
  }

  /** Whether this row is the one currently supplying the guide. */
  private isCurrent(channel: KnownChannel): boolean {
    const inForce = this.current();
    return (
      !!inForce &&
      inForce.channel.id === channel.id &&
      inForce.channel.sourceId === channel.sourceId
    );
  }

  /**
   * Works out which guide channel this stream is drawing from.
   *
   * The hand-made mapping if there is one, and otherwise the same automatic
   * resolution the listing itself performs -- asked here rather than passed in,
   * so the two cannot drift apart and show different answers.
   */
  private whatIsInForce(): { channel: KnownChannel; byHand: boolean } | null {
    const mapping = this.mapping;

    if (mapping) {
      const channel = this.channels.find(
        candidate =>
          candidate.id === mapping.channelId && candidate.sourceId === mapping.sourceId
      );
      // A mapping pointing at a guide this device has not loaded still counts:
      // it is in force, the schedule is simply not here yet.
      return {
        channel: channel ?? {
          id: mapping.channelId,
          name: mapping.channelId,
          sourceId: mapping.sourceId
        },
        byHand: true
      };
    }

    const resolved = resolveGuideChannel(
      indexGuideChannels(this.channels),
      this.stream().epg_channel_id,
      this.stream().name
    );

    return resolved ? { channel: resolved, byHand: false } : null;
  }

  /** The name of a source, for the filter chips and the rows. */
  private sourceLabel(sourceId: string): string {
    const label = this.sources.sources().find(source => source.id === sourceId)?.label;
    return label ? guideName(label) : t('cgp.unknownGuide');
  }

  /** Where the guide in force comes from, by name. */
  readonly currentSource = computed(() => {
    const inForce = this.current();
    return inForce ? this.sourceLabel(inForce.channel.sourceId) : '';
  });

  /** The rows offered, each with its guide's name and whether it is the one in force. */
  readonly rows = computed(() =>
    this.suggestions().map(suggestion => ({
      suggestion,
      inUse: this.isCurrent(suggestion.channel),
      source: this.sourceLabel(suggestion.channel.sourceId)
    }))
  );

  /** A chip per guide: whether it is chosen, and how many candidates it holds. */
  readonly chips = computed(() => {
    const chosen = this.chosenSources();
    const all = this.unfiltered();
    return this.sources.sources().map(source => ({
      source,
      chosen: chosen.includes(source.id),
      count: all.filter(entry => entry.channel.sourceId === source.id).length
    }));
  });

  /** Candidates across every guide, for the "All" chip. */
  readonly allCount = computed(() => this.unfiltered().length);

  /** "All sources": no filter. */
  allSources(): void {
    this.chosenSources.set([]);
    this.refresh();
  }

  // The chips' counts are of the candidates without the source filter, so a
  // chip says what choosing it would show rather than what is showing now.
  private readonly unfiltered = signal<ChannelSuggestion[]>([]);

  /** How many guide channels this device holds, for the header. */
  readonly channelCount = signal(0);

  /** The channel's name and tags as the guide draws them. */
  readonly display = computed(() => channelDisplay(this.streamName()));
  private readonly streamName = signal('');

  /** The provider's channel number, when it sends one. */
  readonly channelNumber = computed(() => {
    const num = (this.stream() as unknown as Record<string, unknown>)['num'];
    return num === null || num === undefined || num === '' ? '' : String(num);
  });

  toggleSource(sourceId: string): void {
    const chosen = this.chosenSources();
    this.chosenSources.set(
      chosen.includes(sourceId)
        ? chosen.filter(id => id !== sourceId)
        : [...chosen, sourceId]
    );
    this.refresh();
  }

  choose(suggestion: ChannelSuggestion): void {
    this.sources.map(
      String(this.stream().stream_id),
      suggestion.channel.id,
      suggestion.channel.sourceId
    );
    this.changed.emit();
    this.closed.emit();
  }

  /**
   * Returns the stream to automatic matching.
   *
   * Not the same as mapping it to nothing: someone undoing a choice wants the
   * guess back rather than an empty row.
   */
  useAutomatic(): void {
    this.sources.unmap(String(this.stream().stream_id));
    this.changed.emit();
    this.closed.emit();
  }

  close(): void {
    this.closed.emit();
  }

  private refresh(): void {
    const search = this.search.value.trim();

    const suggested = suggestGuideChannels(
      { name: this.stream().name, epg_channel_id: this.stream().epg_channel_id },
      this.channels,
      { search, sourceIds: this.chosenSources(), limit: 40 }
    );

    this.unfiltered.set(
      this.chosenSources().length
        ? suggestGuideChannels(
            { name: this.stream().name, epg_channel_id: this.stream().epg_channel_id },
            this.channels,
            { search, limit: 40 }
          )
        : suggested
    );

    const inForce = this.current();

    // The channel in use is always offered, and first.
    //
    // It will not always be suggested on its own: a hand-made mapping is often
    // to something the name scoring would never propose, which is why it was
    // made by hand. Showing everything except the answer already in force
    // would be a strange list.
    //
    // A search is left alone -- someone typing has asked for something
    // particular, and pinning an unrelated row on top of it would be noise.
    if (inForce && !search && !suggested.some(entry => this.isCurrent(entry.channel))) {
      this.suggestions.set([
        { channel: inForce.channel, score: 1, because: 'id' as const },
        ...suggested
      ]);
      return;
    }

    this.suggestions.set(suggested);
    this.rescue.set(suggested.length ? '' : this.wayOutOf(search));
  }

  /**
   * Whether a search that found nothing has a repaired version that finds
   * something, and what it is.
   *
   * Run only on an empty result, so the cost is paid on the screen that has
   * nothing else to show. Scoring a few thousand channels held in memory is
   * not the expensive part of anything here.
   */
  private wayOutOf(search: string): string {
    const repaired = searchWithoutProviderNoise(search);

    if (!repaired) {
      return '';
    }

    const found = suggestGuideChannels(
      { name: this.stream().name, epg_channel_id: this.stream().epg_channel_id },
      this.channels,
      { search: repaired, sourceIds: this.chosenSources(), limit: 1 }
    );

    return found.length ? repaired : '';
  }

  /** Takes the offered search, which re-runs everything through refresh(). */
  useRescue(): void {
    this.search.setValue(this.rescue());
  }
}
