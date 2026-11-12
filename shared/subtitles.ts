import { StreamType } from './types';

/**
 * A subtitle an account added from OpenSubtitles, as the sync service keeps it.
 *
 * Kept per account so the phone, the television and the PC can all play with
 * it without spending another of the day's downloads. Never shared between
 * accounts: that would be re-hosting OpenSubtitles' files for other people.
 *
 * Not part of the change feed. A subtitle is looked up for the one film or
 * episode about to play, and the text is tens of kilobytes -- a first sync
 * that pulled every file an account ever added would be megabytes for nothing.
 */

/** A film is `vod` with its stream id; an episode is `series` with its episode id, as in watch history. */
export type SubtitleItemType = Extract<StreamType, 'vod' | 'series'>;

export interface SavedSubtitle {
  /** The service's own id for this row. */
  id: string;
  type: SubtitleItemType;
  itemId: string;
  /** For an episode: the show, season and episode, so a list can say which. */
  seriesId: string | null;
  season: number | null;
  episodeNum: number | null;
  /** The film or show's name, for the Account page's list. */
  name: string | null;
  /** ISO 639-1, as OpenSubtitles spells it (`hr`, `en`, `pt-br`). */
  language: string;
  /** The release name, which is what tells two subtitles for the same film apart. */
  release: string;
  /** OpenSubtitles' file id, so adding the same file again replaces rather than duplicates. */
  fileId: number;
  hearingImpaired: boolean;
  /** Milliseconds; positive shows the words later. */
  offsetMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface SavedSubtitleWithText extends SavedSubtitle {
  /** WebVTT. Devices convert SRT before saving. */
  text: string;
}

/** What a device sends to add one. */
export interface NewSubtitle {
  type: SubtitleItemType;
  itemId: string;
  seriesId?: string | null;
  season?: number | null;
  episodeNum?: number | null;
  name?: string | null;
  language: string;
  release: string;
  fileId: number;
  hearingImpaired?: boolean;
  offsetMs?: number;
  text: string;
}

/**
 * The largest file kept, in UTF-8 bytes.
 *
 * A two-hour film's subtitles are 50 to 150 KB. Half a megabyte leaves room for
 * a long one with styling and stays well inside D1's row limit.
 */
export const MAX_SUBTITLE_BYTES = 512 * 1024;

/**
 * How many one account may keep. Plenty for a household; a stop for a loop
 * gone wrong -- and, at half a megabyte each, a hundred megabytes at most of
 * a database every account shares.
 */
export const MAX_SUBTITLES_PER_ACCOUNT = 200;

/** How many one film or episode may keep. */
export const MAX_SUBTITLES_PER_ITEM = 10;

/**
 * One press of Earlier or Later.
 *
 * Half a second, as ST-TV-3 draws it: small enough to land on the right answer
 * and large enough to get there in a few presses.
 */
export const SUBTITLE_OFFSET_STEP_MS = 500;

/** How far an offset may go either way. A subtitle a minute out is for another cut. */
export const MAX_SUBTITLE_OFFSET_MS = 60_000;

/** The one format kept, checked by its signature line. */
export const isWebVtt = (text: string): boolean => /^﻿?WEBVTT(?:[ \t]|\r?\n|$)/.test(text);
