export type StreamType = 'live' | 'vod' | 'series';

/** How a category list may be ordered. */
export type CategorySort = 'name_asc' | 'name_desc' | 'manual';

/**
 * How a stream list may be ordered. `number` uses the provider's channel
 * number; `closest` is search only -- how closely a name answers what was
 * typed (`shared/xtream/searchRanking.ts`), and falls back to name order
 * anywhere there is no query to be close to.
 */
export type StreamSort =
  | 'name_asc'
  | 'name_desc'
  | 'number'
  | 'added_desc'
  | 'added_asc'
  | 'manual'
  | 'closest';

export const CATEGORY_SORTS: readonly CategorySort[] = ['name_asc', 'name_desc', 'manual'];
export const STREAM_SORTS: readonly StreamSort[] = [
  'name_asc',
  'name_desc',
  'number',
  'added_desc',
  'added_asc',
  'manual',
  'closest'
];

/** A saved manual ordering: item ids in the order the user arranged them. */
export interface ManualOrder {
  scope: string;
  itemIds: string[];
}

export interface Stream {
  stream_id: string;
  name: string;
  icon: string;
  stream_icon?: string;
  type?: StreamType;
  stream_type?: string;
  /** The category the provider files it under; what hiding and locking go by. */
  category_id?: string;
  /**
   * Which of the account's providers this came from: its slot tag, '' for the
   * first (see shared/providers). Set by the merged catalogue.
   */
  provider?: string;
  epg_channel_id?: string;
  added?: string;
  /** The provider's channel number, where it gives one. */
  num?: number | string | null;
  /**
   * Whether the provider keeps this channel's past for catch-up (1) or not
   * (0), and for how many days. Live channels only; absent on a row stored
   * before they were kept, which is how `Catalogue.streams` knows to ask again.
   */
  tv_archive?: number;
  tv_archive_duration?: number;
  /** A Stalker portal's command for this stream, which create_link turns into an address (shared/stalker). */
  portal_cmd?: string;
}

export interface Category {
  category_id: string;
  category_name: string;
  parent_id: string;
  /** The provider's slot tag, as on `Stream`. */
  provider?: string;
}

export interface SyncStatus {
  synced: boolean;
  lastSync?: string;
  totalCategories?: number;
  totalStreams?: number;
  status?: string;
  message?: string;
  cancelled?: boolean;
}

export enum SyncStatusState {
  SYNCED = 'synced',
  ERROR = 'error',
  PENDING = 'pending',
  CANCELLED = 'cancelled',
  SYNCING = 'syncing',
  NOT_SYNCED = 'not_synced',
  UNKNOWN = 'unknown'
}

export interface EPGProgram {
  id: string;
  title: string;
  start_timestamp: number;
  stop_timestamp: number;
  description: string;
}

export interface EPGListing {
  epg_listings: EPGProgram[];
}

export interface SeriesInfo {
  id: string;
  name: string;
  plot: string;
  cast: string;
  director: string;
  genre: string;
  releaseDate: string;
  last_modified: string;
  rating: number;
  rating_5based: number;
  backdrop_path: string[];
  youtube_trailer: string;
  episode_run_time: string;
  category_id: string;
  episodes?: { [season: string]: Episode[] };
}

export interface Episode {
  id: string;
  episode_num: number;
  title: string;
  container_extension: string;
  info: {
    video: {
      duration: string;
    };
    movie_image?: string;
    duration?: string;
  };
  season: number;
}

export interface LoginCredentials {
  username: string;
  password: string;
  serverUrl: string;
}

export interface UserInfo {
  username: string;
  password: string;
  message: string;
  auth: number;
  status: string;
  exp_date: string;
  is_trial: string;
  active_cons: string;
  created_at: string;
  max_connections: string;
  allowed_output_formats: string[];
}

export interface SyncTypeDetail {
  type: StreamType;
  success: boolean;
  message?: string;
  syncedItems?: number;
  totalCategories?: number;
}

export interface SyncStatusRecord {
  last_sync: string;
  status: SyncStatusState;
  total_streams: number;
  total_categories: number;
  type: StreamType;
}

export function isSyncStatusRecord(obj: any): obj is SyncStatusRecord {
  return obj && 
    typeof obj.last_sync === 'string' &&
    typeof obj.status === 'string' &&
    typeof obj.total_streams === 'number' &&
    typeof obj.total_categories === 'number' &&
    typeof obj.type === 'string';
}

export interface ExternalEPGChannel {
  id: string;
  name: string;
  displayName: string;
  icon?: string;
}

export interface ExternalEPGProgramme {
  channel: string;
  start: string;
  stop: string;
  title: string;
  desc?: string;
  description?: string;
  category?: string;
}

/**
 * Where the user got to in something they were watching.
 *
 * One row per playable thing. For live and movies that is the stream itself;
 * for a show it is a single episode, with `seriesId` grouping every episode of
 * that show together so "continue watching" lists the show once rather than
 * once per episode.
 *
 * The display fields are copied in rather than joined from `streams`: an
 * episode has no row there at all, and a channel the provider drops disappears
 * from it on the next sync. History should outlive both.
 */
export interface WatchProgress {
  type: StreamType;
  /** A stream_id for live and movies; an episode id for a show. */
  itemId: string;
  /** Set only for episodes. */
  seriesId?: string | null;
  season?: number | null;
  episodeNum?: number | null;
  /** The channel, film or show name -- what the card is headed with. */
  name: string;
  episodeTitle?: string | null;
  icon?: string | null;
  /** Needed to build a playback URL for an episode without refetching it. */
  containerExtension?: string | null;
  positionSeconds: number;
  /** Zero when unknown, which is normal for live. */
  durationSeconds: number;
  completed: boolean;
  updatedAt: string;
}

/** What a client sends to record a position. */
export type WatchProgressInput = Omit<WatchProgress, 'completed' | 'updatedAt'> & {
  completed?: boolean;
};

/** How many recently watched entries a section shows. */
export const RECENT_LIMIT = 10;

/**
 * An account of the user's own.
 *
 * Deliberately not the Xtream identity: that is a credential with an expiry
 * date, and everything the user builds hangs off this instead so a renewal
 * cannot strand it.
 */
export interface Account {
  id: number;
  username: string;
  createdAt: string;
  /** Where it stands in its family (shared/family.ts). Missing from an older service: an admin. */
  role?: 'admin' | 'member' | 'kid';
  /** The account directly above it, or null at the top of its own family. */
  managerId?: number | null;
  /** Whether it is a profile on its managers' own devices. */
  household?: boolean;
  /** Its profile picture (shared/profilePicture.ts); null or missing for the one from its name. */
  picture?: string | null;
}

/** A subscription belonging to an account. Never carries the password. */
export interface ProviderSubscription {
  /**
   * Opaque, and not always a number.
   *
   * The Express backend numbers its rows. The sync service cannot: the
   * address and the username it would key on are inside ciphertext it holds no
   * key to, so the device names the subscription instead and sends a hash. See
   * `subscriptionId` in xtream/guideSourceId.ts.
   */
  id: number | string;
  userId: number;
  label: string | null;
  serverUrl: string;
  xtreamUsername: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What the client sends to store or renew a subscription. */
export interface ProviderSubscriptionInput {
  serverUrl: string;
  username: string;
  password: string;
  label?: string;
}

/**
 * Preferences that follow the account rather than the browser.
 *
 * Named here so the client and the server cannot drift apart on spelling: a
 * setting written under one key and read under another is silently no setting
 * at all.
 */
export const SETTING_KEYS = {
  theme: 'theme',
  categorySort: 'categorySort',
  streamSort: 'streamSort',
  /** When this device last chose each sort, so a newer arrangement can win (xtream/ordering.ts, sortToUse). */
  categorySortAt: 'categorySortAt',
  streamSortAt: 'streamSortAt',
  /**
   * The sorts chosen while somebody set this account up, each as a JSON
   * `SortChoice`. Account-wide, unlike the device's own: a sort picked for a
   * family member on the admin's desktop has to reach their television
   * (sortToUse).
   */
  setUpCategorySort: 'setUpCategorySort',
  setUpStreamSort: 'setUpStreamSort',
  /**
   * How playback looks and sounds, as one JSON blob.
   *
   * One key rather than seven, because the players read it all at once and a
   * partly-arrived set of caption settings is worse than a slightly stale
   * one -- subtitles at the old size and the new colour is a state nobody
   * asked for. See shared/player.ts.
   */
  player: 'player',
  /** How recordings are made: minutes before and after, days kept (shared/recording/plan.ts). */
  recordingSettings: 'recordingSettings',
  /**
   * Categories put out of the way, and categories behind the PIN, each as
   * `{ live: [...ids], vod: [...], series: [...] }`. Account-wide, so a lock set
   * on one device holds on the others. See category-lock.utils.ts.
   */
  hiddenCategories: 'hiddenCategories',
  lockedCategories: 'lockedCategories',
  /** The PIN's salt and hash, and how long untouched before it locks again. Never the PIN. */
  parentalLock: 'parentalLock',
  /**
   * Films and shows locked by age rating, as JSON `{ limit, country }` --
   * nothing without a PIN, like the locked categories (shared/tmdb/age.ts).
   */
  ageLock: 'ageLock',
  /**
   * The languages copies and trailers are offered in, first first, as a
   * JSON array of codes; unset for the app's language, then English
   * (shared/languages.ts).
   */
  languages: 'languages',
  /** The copy chosen for each film and show, as ordered pairs (shared/copyChoices.ts). */
  copyChoices: 'copyChoices',
  /** 'off' to stop a television playing the channel in focus above the guide; on otherwise. */
  channelPreview: 'channelPreview',
  /**
   * What a manager keeps in step for the members it set up -- its providers
   * and guides -- as `FamilyLinks` (shared/providers/familySetup.ts).
   */
  familyLinks: 'familyLinks',
  /** Guide matches handed over by a manager, for this account to make by channel name. */
  familyGuideMatches: 'familyGuideMatches',
  /**
   * Whose words describe films and shows: 'provider', or TMDB's in 'en' or
   * 'hr' (shared/tmdb/describe.ts).
   */
  descriptionLanguage: 'descriptionLanguage',
  /**
   * Shows taken out of Continue watching, by show id, with when -- each comes
   * back once watched again (frontend/src/app/utils/for-you.utils.ts).
   */
  continueHidden: 'continueHidden',
  /**
   * 'on' to have a television open into the last channel watched instead of
   * For You (shared/startup.ts). Account-wide, like the picture settings.
   */
  openLastChannel: 'openLastChannel',
  /**
   * 'off' to stop this account's devices sending error reports; on otherwise
   * (shared/errorReports.ts). Account-wide: turned off once, it is off on
   * the television and the phone as well, and the tvinto CLI can set it.
   */
  errorReports: 'errorReports'
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];
