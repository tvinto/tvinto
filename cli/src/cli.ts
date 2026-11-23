import { bookRecording, cancelRecording, recordEvery, recordingOption, recordingsView, stopEvery, when } from './recordings';
import {
  ProviderView,
  family,
  guides,
  providers,
  askTheApp,
  memberNamed,
  memberSession,
  session,
  settings,
  signIn,
  signInByApproval,
  signOut,
  status,
  toolName,
  untrusted
} from './account';
import { asJson, asText, onOff, quoted } from './output';
import { Change, Line, apply, history, propose, undoLast, waitingFor } from './changes';
import {
  PLAYER_HELP,
  SORTS,
  TYPE_WORDS,
  descriptionsChange,
  guideAddChange,
  guideChange,
  guideRemoveChange,
  hideChange,
  lastChannelChange,
  errorReportsChange,
  ageLockChange,
  languagesChange,
  previewChange,
  ageLockLoosens,
  lockChange,
  matchChange,
  memberChange,
  pictureChange,
  orderChange,
  pinMatches,
  playerChange,
  sortChange,
  unmatchChange
} from './edits';
import { categories, channelName, channels } from './provider';
import { OpenedGuide, guideChannels, openedGuides } from './guideChannels';
import { indexGuideChannels, resolveGuideChannel } from '../../shared/xtream/guideMatching';
import { suggestGuideChannels } from '../../shared/xtream/guideSuggestions';
import { epgShareCountries, epgShareFor, epgShareUrl, suggestedCountry } from '../../shared/xtream/epgShare';
import { KnownChannel } from '../../shared/xtream/guide';
import { SETTING_KEYS } from '../../shared/types';
import { DESCRIPTION_LANGUAGES } from '../../shared/tmdb/describe';
import { readCategorySets } from '../../shared/categoryLock';
import { Terminal } from './prompt';
import { Fetch } from './service';
import { SecretStore, readConfig } from './store';
import { Runner, serverInit, serverTmdbKey } from './server';
import fs from 'fs';
import path from 'path';

/** An image file named on the command line, as a data address; a word (auto, fox) as it is. */
function pictureArgument(argument: string): string {
  const types: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  const type = types[path.extname(argument).toLowerCase()];
  if (!type) {
    return argument.toLowerCase();
  }
  if (!fs.existsSync(argument)) {
    throw new Error(`No file at ${argument}.`);
  }
  return `data:${type};base64,${fs.readFileSync(argument).toString('base64')}`;
}

/**
 * tvinto's commands: signing in and out, reading the
 * account, and changing it -- every change previewed with a code first, and
 * undoable.
 *
 * Everything outside -- the network, the credential store, the terminal --
 * is handed in, so the tests run the real commands against the real Worker.
 */

export interface Deps {
  fetch: Fetch;
  store: SecretStore;
  terminal: Terminal;
  hostname: string;
  write(text: string): void;
  /** Opens the desktop app on a link, if this machine can. Signing in by approval. */
  openLink?(url: string): void;
  /** Waits between asking whether a sign-in was allowed. */
  wait?(ms: number): Promise<void>;
  /** Runs wrangler for `tvinto server init`; only where a person runs tvinto. */
  run?: Runner;
  /** This computer's locales, for the guide `tvinto guide suggest` offers: LC_ALL, LANG and Intl's when not given. */
  locales?: string[];
}

/** The locales this computer names, most telling first. */
function computerLocales(): string[] {
  let intl = '';
  try {
    intl = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    // The variables alone.
  }
  return [process.env['LC_ALL'], process.env['LANG'], intl].filter((locale): locale is string => !!locale);
}

export const VERSION = '0.1.0';

const HELP = `tvinto ${VERSION} -- a Tvinto account from the command line

  tvinto sign-in --server <address> [--user <name>] [--history] [--password]
      Signs in as a tool: the Tvinto app opens and asks you to allow it.
      --password asks for the password here instead. --history also lets
      it read favourites and watch history.
  tvinto sign-in --local
      The Tvinto app on this computer, used without an account: it asks you
      to allow it, and tvinto then works on what that app keeps.
  tvinto sign-out
  tvinto status
  tvinto providers      Each provider: its name, host, and whether it is on.
  tvinto guides         Each guide: its name, host, and channels matched by hand.
  tvinto settings       Sorts, hidden and locked categories, the player.
  tvinto recordings     What is booked, on which device, and how recordings are made.
  tvinto family         Who is in the family.
  tvinto categories <live|movies|series> [--fresh]
                        Categories from the providers and playlists, with their ids.
  tvinto channels <category id> [--suggest] [--fresh]
                        A live category's channels, and how each finds its guide.
                        --suggest reads the guides' channel lists and offers one
                        for each channel that has none.
  tvinto guide channels <guide id> [search]
                        A guide's channels, with the ids matching takes.
  tvinto guide suggest [--country <code>] [--add]
                        EPG Share's free guide for this computer's country, or
                        another (HR, DE, GB...), as the app suggests it. --add
                        adds it to the account.

Changes answer with what they will do and a code; nothing changes until
  tvinto apply <code>   within five minutes. tvinto undo puts the last one back.

  tvinto sort <categories|channels> <sort|default>
  tvinto hide <live|movies|series> <id...>     and: unhide
  tvinto lock <live|movies|series> <id...>     and: unlock (the PIN, at a terminal)
  tvinto order <live|movies|series> <id...>    these categories first
  tvinto guide <on|off|remove> <id>
  tvinto guide add [name]                      the address, at a terminal
  tvinto match <guide id> <channel id> <guide channel id> [<channel id> <guide channel id>...]
                                               a channel's guide, by hand
  tvinto unmatch <channel id...>               back to finding it automatically
  tvinto player <setting> <value>              subtitles, sizes, languages
  tvinto descriptions <provider|en|hr|de|...>
  tvinto last-channel <on|off>                 televisions open into it
  tvinto preview <on|off>                      a television plays the channel in focus
  tvinto error-reports <on|off>                the apps send error reports (nothing personal)
  tvinto languages <code...|default>          copies and trailers in this order, up to 3
  tvinto age-lock <off|12|16|18> [HR|DE|US|GB] films and shows by age rating (opening up: the PIN)
  tvinto recordings book <channel id> <YYYY-MM-DDTHH:MM> <minutes> <device> [title]
                                               recorded by that television, phone or computer
  tvinto recordings cancel <id>
  tvinto recordings every <channel id> <guide channel id> <device> <title>
                                               every airing of that title on that channel
  tvinto recordings stop-every <id>
  tvinto recordings <before|after> <minutes>   start early, go on after the end
  tvinto recordings keep <days|forever>
  tvinto undo
  tvinto history        The changes applied from here.

  tvinto picture <auto|animal|image file>     your profile picture: dog, cat, fox, panda,
                                               lion, tiger, koala, rabbit, or a small
                                               JPEG/PNG/WebP (256 px, under 45 KB)
  tvinto family role <name> <admin|member|kid>
  tvinto family household <name> <on|off>      a profile on this account's devices
  tvinto family picture <name> <auto|animal|image file>

Asked of the app, which does it on a click (a password it makes shows there only):
  tvinto family add <name> <admin|member|kid> [household]
  tvinto family remove <name>
  tvinto family reset-password <name>
  tvinto pin off

  --for <name>          Any change or read above, for a family member below
                        this account: their providers, guides, sorts, player...
  --json                Any command's answer as JSON.

  tvinto server init [folder]
                        A sync service of your own on your own Cloudflare
                        account, written to the folder (tvinto-server unless
                        given) and deployed with wrangler, which signs you in
                        to Cloudflare itself. Again in the same folder: an update.
  tvinto server tmdb-key [folder]
                        The service's TMDB key (free, from
                        themoviedb.org/settings/api), checked with TMDB and set
                        with wrangler. Every app signed in to it then gets
                        posters, descriptions and Popular without a key of its own.

  tvinto mcp            An MCP server on stdin/stdout, for an AI agent, using
                        this sign-in. Reads and previews only; apply needs a code.
                        Claude Code: claude mcp add tvinto -- node <path>/tvinto.js mcp

A tool cannot change the password, invite anyone or change the family; those
stay with the app. It shows no provider login and no full provider address.`;

interface Flags {
  json: boolean;
  /** The desktop app on this computer, used without an account. */
  local: boolean;
  /** A family member to act on instead of the account itself. */
  for: string | null;
  password: boolean;
  user: string | null;
  fresh: boolean;
  suggest: boolean;
  /** `guide suggest`: a country instead of this computer's, and adding it. */
  country: string | null;
  add: boolean;
  history: boolean;
  server: string | null;
  help: boolean;
  version: boolean;
}

function parse(argv: string[]): { command: string | null; args: string[]; flags: Flags; unknown: string[] } {
  const flags: Flags = { json: false, local: false, for: null, password: false, user: null, fresh: false, suggest: false, country: null, add: false, history: false, server: null, help: false, version: false };
  const unknown: string[] = [];
  const args: string[] = [];
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--fresh') {
      flags.fresh = true;
    } else if (arg === '--suggest') {
      flags.suggest = true;
    } else if (arg === '--country') {
      flags.country = argv[++i] ?? '';
    } else if (arg.startsWith('--country=')) {
      flags.country = arg.slice('--country='.length);
    } else if (arg === '--add') {
      flags.add = true;
    } else if (arg === '--for') {
      flags.for = argv[++i] ?? '';
    } else if (arg.startsWith('--for=')) {
      flags.for = arg.slice('--for='.length);
    } else if (arg === '--local') {
      flags.local = true;
    } else if (arg === '--password') {
      flags.password = true;
    } else if (arg === '--user') {
      flags.user = argv[++i] ?? '';
    } else if (arg.startsWith('--user=')) {
      flags.user = arg.slice('--user='.length);
    } else if (arg === '--history') {
      flags.history = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true;
    } else if (arg === '--server') {
      flags.server = argv[++i] ?? '';
    } else if (arg.startsWith('--server=')) {
      flags.server = arg.slice('--server='.length);
    } else if (!command && !arg.startsWith('-')) {
      command = arg;
    } else if (!arg.startsWith('-')) {
      args.push(arg);
    } else {
      unknown.push(arg);
    }
  }
  return { command, args, flags, unknown };
}

/** A setting's value in a pull, or null. */
const value = (pulled: { settings?: { key: string; value: string }[] }, key: string): string | null =>
  (pulled.settings ?? []).find(setting => setting.key === key)?.value ?? null;

/** Commands that take nothing after them. */
const TAKES_NOTHING = new Set(['sign-in', 'sign-out', 'status', 'providers', 'guides', 'settings', 'undo', 'history']);

/** A guide of the account by the id `tvinto guides` gives. */
async function guideNamed(current: Parameters<typeof openedGuides>[0], pulled: Parameters<typeof openedGuides>[1], id: string): Promise<OpenedGuide> {
  const guide = (await openedGuides(current, pulled)).find(candidate => candidate.id === id);
  if (!guide) {
    throw new Error(`No guide ${id}. tvinto guides lists them with their ids.`);
  }
  return guide;
}

/** Runs one command. The exit code: 0, or 1 for anything refused or failed. */
export async function run(argv: string[], deps: Deps): Promise<number> {
  const { command, args, flags, unknown } = parse(argv);
  const print = (lines: string[], result: unknown) =>
    deps.write(`${flags.json ? asJson(result) : asText(lines, result)}\n`);
  const render = (line: Line) => line.map(part => (typeof part === 'string' ? part : quoted(part))).join('');

  /** A change, previewed: what it does and the code that applies it. Nothing is written. */
  const preview = (current: Awaited<ReturnType<typeof session>>, change: Change, undoes?: string) => {
    // Whose account, when it is a family member's: nobody should apply a change
    // to the wrong one.
    if (current.memberId !== undefined) {
      const member = current.config.username.slice(current.config.username.indexOf('/') + 1);
      change = { ...change, lines: [['For ', untrusted(member), ':'], ...change.lines] };
    }
    const code = propose(current, change, undoes);
    print(
      [...change.lines.map(render), '', `Nothing has changed yet. To do this: tvinto apply ${code}  (five minutes)`],
      { preview: change.lines, code, expiresInMinutes: 5 }
    );
  };

  /** The PIN, typed at a terminal by a person -- never an argument. True when it is the account's. */
  const askPin = async (pulled: Parameters<typeof pinMatches>[0]): Promise<boolean> => {
    if (!deps.terminal.isTTY) {
      throw new Error('This needs the PIN, typed at a terminal.');
    }
    if (!(await pinMatches(pulled, await deps.terminal.askHidden('PIN: ')))) {
      throw new Error('That is not the PIN.');
    }
    return true;
  };

  /** Showing what was asked of the app, opening it on the request, and waiting. */
  const appHooks = (what: string) => ({
    asked: (_code: string, link: string) => {
      deps.write(`Asked in the Tvinto app: ${what}. Allow it there -- it opens now, or find it on Account, Tools.\n`);
      deps.write(`If the app did not open: ${link}\nWaiting (ten minutes at most)...\n`);
      deps.openLink?.(link);
    },
    wait: deps.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  });

  /** The account this command acts on: the one signed in, or a family member with --for. */
  const acting = async () => {
    const own = await session(deps.fetch, deps.store);
    return flags.for ? memberSession(own, flags.for, deps.store) : own;
  };

  const typeOf = (word: string | undefined) => {
    const type = word ? TYPE_WORDS[word] : undefined;
    if (!type) {
      throw new Error('Say which: live, movies or series.');
    }
    return type;
  };

  if (flags.version) {
    deps.write(`${VERSION}\n`);
    return 0;
  }
  if (flags.help || !command) {
    deps.write(`${HELP}\n`);
    return command || flags.help ? 0 : 1;
  }
  if (unknown.length || (TAKES_NOTHING.has(command) && args.length)) {
    deps.write(`tvinto: did not understand ${[...unknown, ...args].join(' ')}\n`);
    return 1;
  }

  try {
    switch (command) {
      case 'sign-in': {
        // The desktop app answers on this address while it is used without an
        // account (frontend/electron/src/localApi.ts).
        if (flags.local) {
          flags.server = 'http://127.0.0.1:47390';
          flags.user = flags.user ?? 'this device';
        }
        const server = flags.server ?? readConfig()?.server ?? null;
        if (!server) {
          deps.write('tvinto: say which sync service: tvinto sign-in --server <address>\n');
          return 1;
        }
        const name = toolName(deps.hostname);
        let config;
        if (flags.password) {
          if (!deps.terminal.isTTY) {
            deps.write('tvinto: sign-in asks for the password at a terminal, and only there.\n');
            return 1;
          }
          const username = flags.user || (await deps.terminal.ask('Username: '));
          const password = await deps.terminal.askHidden('Password: ');
          config = await signIn({ server, username, password, history: flags.history, name }, deps.fetch, deps.store);
        } else {
          // No password: a device of the account allows it (worker/src/toolRequests.ts).
          const username = flags.user || (deps.terminal.isTTY ? await deps.terminal.ask('Username: ') : '');
          if (!username) {
            throw new Error('Say which account: tvinto sign-in --user <name>');
          }
          config = await signInByApproval({ server, username, history: flags.history, name }, deps.fetch, deps.store, {
            asked: (code, link) => {
              // The app on this computer asks the moment the request arrives.
              // A link would only start a copy of the app that is not the one
              // asked, so none is opened.
              if (flags.local) {
                deps.write(`Allow "${name}" in the Tvinto app, which asks now. It shows the code ${code}.\nWaiting (ten minutes at most)...\n`);
                return;
              }
              deps.write(
                `Allow "${name}" in the Tvinto app -- it opens now, or find it on Account, Tools. It shows the code ${code}.\n` +
                  `If the app did not open: ${link}\n` +
                  'Waiting (ten minutes at most)...\n'
              );
              deps.openLink?.(link);
            },
            wait: deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
            confirm: async wrong => {
              if (!deps.terminal.isTTY) {
                throw new Error('Allowed in the app: type the confirmation it shows, at a terminal.');
              }
              return deps.terminal.ask(
                wrong ? 'That was not it. Confirmation from the app: ' : 'Allowed. Type the confirmation the app shows: '
              );
            }
          });
        }
        print(
          [
            `Signed in as ${config.username} on ${new URL(config.server).host}, as "${toolName(deps.hostname)}".`,
            flags.history
              ? 'It can read and change favourites and watch history.'
              : 'It cannot see favourites or watch history.',
            'Sign it out here with tvinto sign-out, or in the app: Account, Tools.'
          ],
          { signedIn: config.username, server: new URL(config.server).host, history: flags.history }
        );
        return 0;
      }

      case 'sign-out': {
        const was = await signOut(deps.fetch, deps.store);
        print([was ? 'Signed out.' : 'Not signed in.'], { signedOut: was });
        return 0;
      }

      case 'status': {
        const view = await status(await acting());
        print(
          [
            `${view.username} on ${view.server}, ${view.role}.`,
            `${view.providers} ${view.providers === 1 ? 'provider' : 'providers'}.`
          ],
          view
        );
        return 0;
      }

      case 'providers': {
        const view = await providers(await acting());
        const line = (provider: ProviderView) =>
          `${quoted(provider.label)} -- ${provider.host} (${provider.kind === 'xtream' ? 'Xtream' : provider.kind === 'stalker' ? 'Portal (MAC)' : 'M3U'}), ${onOff(provider.enabled)}` +
          (provider.sharedBy ? `, shared by ${quoted(provider.sharedBy)}` : '');
        print(
          [
            ...(view.providers.length ? view.providers.map(line) : ['No providers.']),
            ...(view.unreadable ? [`${view.unreadable} more could not be opened with this sign-in's key.`] : [])
          ],
          view
        );
        return 0;
      }

      case 'guides': {
        const view = await guides(await acting());
        print(
          [
            ...(view.guides.length
              ? view.guides.map(
                  guide =>
                    `${guide.id}  ${quoted(guide.label)} -- ${guide.host}, ${onOff(guide.enabled)}, ${guide.matchedByHand} matched by hand`
                )
              : ['No guides.']),
            ...(view.unreadable ? [`${view.unreadable} more could not be opened with this sign-in's key.`] : [])
          ],
          view
        );
        return 0;
      }

      case 'settings': {
        const view = await settings(await acting());
        const player = view.player;
        print(
          [
            `Category sort: ${view.categorySort ?? 'each device its own'}`,
            `Channel sort: ${view.channelSort ?? 'each device its own'}`,
            `Hidden categories: ${view.hiddenCategories}`,
            `Parental lock: ${view.pin ? `on, ${view.lockedCategories} locked, locks again ${view.lockAfterMinutes ? `after ${view.lockAfterMinutes} minutes` : 'on restart'}` : 'no PIN set'}`,
            `Descriptions: ${view.descriptions}`,
            `Open into the last channel: ${onOff(view.openLastChannel)}`,
            `Channel preview on a television: ${onOff(view.channelPreview)}`,
            `Error reports: ${onOff(view.errorReports)}`,
            `Your languages: ${view.languages.length ? view.languages.join(', ') : "the app's, then English"}`,
            `Age lock: ${view.ageLock.limit ? `${view.ageLock.limit} and over, by ${view.ageLock.country}'s ratings` : 'off'}`,
            `Subtitles: ${onOff(player.subtitlesEnabled)}, ${player.subtitleScale}%, ${player.subtitleLanguage || 'any language'}`,
            `Audio: ${player.audioLanguage || 'any language'}`,
            `Match frame rate: ${onOff(player.matchFrameRate)}`,
            `Skip intros: ${player.skipIntros === 'auto' ? 'by themselves' : player.skipIntros === 'off' ? 'off' : 'with a button'}`
          ],
          view
        );
        return 0;
      }

      case 'pin': {
        if (args.length !== 1 || args[0] !== 'off') {
          throw new Error('tvinto pin off -- asks the app, where the PIN is typed.');
        }
        const answer = await askTheApp(await session(deps.fetch, deps.store), 'pin-off', {}, appHooks('Take the parental lock off'));
        print([answer === 'done' ? 'Done: the parental lock is off.' : 'Refused in the app.'], { result: answer });
        return answer === 'done' ? 0 : 1;
      }

      case 'family': {
        if (args[0] === 'add' || args[0] === 'remove' || args[0] === 'reset-password') {
          const current = await session(deps.fetch, deps.store);
          let answer: 'done' | 'refused';
          let what: string;
          if (args[0] === 'add') {
            const [, username, role, extra] = args;
            if (!username || !role || (extra !== undefined && extra !== 'household') || args.length > 4) {
              throw new Error('tvinto family add <name> <admin|member|kid> [household]');
            }
            what = `Add ${username} as ${role}`;
            answer = await askTheApp(current, 'add-member', { username, role, household: extra === 'household' }, appHooks(what));
          } else {
            if (args.length !== 2) {
              throw new Error(`tvinto family ${args[0]} <name>`);
            }
            const member = await memberNamed(current, args[1]);
            what = args[0] === 'remove' ? `Remove ${member.username} from the family` : `Give ${member.username} a new password`;
            answer = await askTheApp(current, args[0] === 'remove' ? 'remove-member' : 'reset-password', { memberId: member.id }, appHooks(what));
          }
          const shownThere = args[0] === 'remove' ? '' : ' The password is shown there, and only there.';
          print([answer === 'done' ? `Done in the app: ${what}.${shownThere}` : 'Refused in the app.'], { result: answer });
          return answer === 'done' ? 0 : 1;
        }
        if (args[0] === 'picture') {
          if (args.length !== 3) {
            throw new Error('tvinto family picture <name> <auto|animal|image file>');
          }
          const current = await session(deps.fetch, deps.store);
          preview(current, pictureChange(await current.service.pull(), await current.service.family(), pictureArgument(args[2]), args[1]));
          return 0;
        }
        if (args[0] === 'role' || args[0] === 'household') {
          if (args.length !== 3) {
            throw new Error('tvinto family role <name> <admin|member|kid>, or tvinto family household <name> <on|off>');
          }
          const current = await session(deps.fetch, deps.store);
          const change =
            args[0] === 'role' ? { role: args[2] } : args[2] === 'on' || args[2] === 'off' ? { household: args[2] === 'on' } : null;
          if (!change) {
            throw new Error('Household is on or off.');
          }
          preview(current, memberChange(await current.service.pull(), await current.service.family(), args[1], change));
          return 0;
        }
        if (args.length) {
          throw new Error(`tvinto: did not understand ${args.join(' ')}`);
        }
        const view = await family(await session(deps.fetch, deps.store));
        print(
          [
            `This account: ${view.role}.`,
            ...(view.managers.length ? [`Set up by: ${view.managers.map(quoted).join(', ')}`] : []),
            ...(view.members.length
              ? view.members.map(
                  member => `${quoted(member.name)} -- ${member.role}${member.household ? ', in the household' : ''}`
                )
              : view.role === 'admin'
                ? ['Nobody else in the family.']
                : [])
          ],
          view
        );
        return 0;
      }

      case 'categories': {
        const current = await acting();
        const type = typeOf(args[0]);
        const found = await categories(current, type, deps.fetch, { fresh: flags.fresh });
        const pulled = await current.service.pull();
        const hidden = new Set(readCategorySets(value(pulled, SETTING_KEYS.hiddenCategories))[type]);
        const locked = new Set(readCategorySets(value(pulled, SETTING_KEYS.lockedCategories))[type]);
        const shown = found.categories.map(category => ({
          ...category,
          hidden: hidden.has(category.id),
          locked: locked.has(category.id)
        }));
        print(
          [
            ...(shown.length
              ? shown.map(
                  category =>
                    `${category.id}  ${quoted(category.name)}${category.hidden ? '  [hidden]' : ''}${category.locked ? '  [locked]' : ''}`
                )
              : ['No categories.'])
          ],
          { categories: shown }
        );
        return 0;
      }

      case 'channels': {
        if (args.length !== 1) {
          throw new Error('tvinto channels <category id>. tvinto categories live lists the ids.');
        }
        const current = await acting();
        const listed = await channels(current, args[0], deps.fetch, { fresh: flags.fresh });
        const pulled = await current.service.pull();
        const byHand = new Map((pulled.channelMappings ?? []).map(mapping => [mapping.streamId, mapping]));
        const guidesNow = await openedGuides(current, pulled);
        const label = (id: string) => guidesNow.find(guide => guide.id === id)?.label ?? id;

        // The guides' channel lists, only when asked: one short download each.
        let known: KnownChannel[] | null = null;
        const unread: string[] = [];
        if (flags.suggest) {
          known = [];
          for (const guide of guidesNow.filter(candidate => candidate.enabled)) {
            try {
              known.push(...(await guideChannels(guide, deps.fetch, { fresh: flags.fresh })));
            } catch (error) {
              unread.push(`${guide.label}: ${(error as Error).message}`);
            }
          }
        }
        const index = known ? indexGuideChannels(known) : null;

        const shown = listed.map(channel => {
          const hand = byHand.get(channel.id);
          const automatic = !hand && index ? resolveGuideChannel(index, channel.guideId?.untrusted, channel.name.untrusted) : null;
          const suggestion =
            !hand && !automatic && known
              ? suggestGuideChannels({ name: channel.name.untrusted, epg_channel_id: channel.guideId?.untrusted }, known, { limit: 1 })[0]
              : undefined;
          return {
            ...channel,
            byHand: hand ? { guide: hand.sourceId, guideChannelId: untrusted(hand.channelId) } : null,
            automatic: automatic ? { guide: automatic.sourceId, guideChannelId: untrusted(automatic.id), name: untrusted(automatic.name) } : null,
            suggestion: suggestion
              ? { guide: suggestion.channel.sourceId, guideChannelId: untrusted(suggestion.channel.id), name: untrusted(suggestion.channel.name) }
              : null
          };
        });
        const describe = (channel: (typeof shown)[number]) => {
          const head = `${channel.id}  ${quoted(channel.name)}`;
          if (channel.byHand) {
            return `${head} -- matched by hand: ${quoted(channel.byHand.guideChannelId)} in ${quoted(untrusted(label(channel.byHand.guide)))}`;
          }
          if (channel.automatic) {
            return `${head} -- found automatically: ${quoted(channel.automatic.guideChannelId)} in ${quoted(untrusted(label(channel.automatic.guide)))}`;
          }
          if (channel.suggestion) {
            return `${head} -- no guide; suggested: ${quoted(channel.suggestion.name)} (${quoted(channel.suggestion.guideChannelId)}) in ${channel.suggestion.guide}`;
          }
          return `${head} -- ${known ? 'no guide' : channel.guideId ? `provider's guide id ${quoted(channel.guideId)}` : "no guide id from the provider"}`;
        };
        print(
          [
            ...(shown.length ? shown.map(describe) : ['No channels in that category.']),
            ...unread.map(line => `Not read: ${line}`),
            ...(known ? [] : ['tvinto channels <id> --suggest also reads the guides, and says which channels have none.'])
          ],
          { channels: shown, guidesNotRead: unread }
        );
        return 0;
      }

      case 'match': {
        if (args.length < 3 || (args.length - 1) % 2 !== 0) {
          throw new Error('tvinto match <guide id> <channel id> <guide channel id> [<channel id> <guide channel id>...]');
        }
        const current = await acting();
        const pulled = await current.service.pull();
        const guide = await guideNamed(current, pulled, args[0]);
        const offered = await guideChannels(guide, deps.fetch);
        const byId = new Map(offered.map(channel => [channel.id, channel]));
        const pairs = [];
        for (let i = 1; i < args.length; i += 2) {
          const target = byId.get(args[i + 1]);
          if (!target) {
            throw new Error(`The guide has no channel ${args[i + 1]}. tvinto guide channels ${guide.id} <search> finds it.`);
          }
          pairs.push({ channelId: args[i], channelName: channelName(current, args[i]), guideChannelId: target.id, guideChannelName: target.name });
        }
        preview(current, matchChange(pulled, guide, pairs));
        return 0;
      }

      case 'unmatch': {
        if (!args.length) {
          throw new Error('tvinto unmatch <channel id...>');
        }
        const current = await acting();
        preview(current, unmatchChange(await current.service.pull(), args.map(id => ({ id, name: channelName(current, id) }))));
        return 0;
      }

      case 'sort': {
        const list = args[0];
        if ((list !== 'categories' && list !== 'channels') || !args[1] || args.length > 2) {
          throw new Error(`tvinto sort <categories|channels> <sort|default>. Sorts: ${SORTS.channels.join(', ')}`);
        }
        const current = await acting();
        preview(current, sortChange(await current.service.pull(), list, args[1]));
        return 0;
      }

      case 'hide':
      case 'unhide':
      case 'lock':
      case 'unlock': {
        const type = typeOf(args[0]);
        const ids = args.slice(1);
        if (!ids.length) {
          throw new Error(`tvinto ${command} <live|movies|series> <id...>. tvinto categories lists the ids.`);
        }
        const current = await acting();
        const pulled = await current.service.pull();
        const known = (await categories(current, type, deps.fetch)).categories;
        const hasPin = Boolean(value(pulled, SETTING_KEYS.parentalLock));
        if (command === 'hide' || command === 'unhide') {
          const pinChecked = command === 'unhide' && hasPin ? await askPin(pulled) : false;
          preview(current, hideChange(pulled, type, known, ids, command === 'hide', pinChecked));
        } else {
          const pinChecked = hasPin ? await askPin(pulled) : false;
          preview(current, lockChange(pulled, type, known, ids, command === 'lock', pinChecked));
        }
        return 0;
      }

      case 'guide': {
        if (args[0] === 'suggest' && args.length === 1) {
          // As onboarding and the Guides page suggest it: this computer's
          // country, or the one asked for. Needs no account until --add.
          const country = flags.country !== null ? flags.country.trim().toUpperCase() : suggestedCountry(deps.locales ?? computerLocales(), null);
          const suggestion = epgShareFor(country);
          if (!suggestion) {
            print(
              [
                country ? `EPG Share has no guide for ${country}.` : 'This computer names no country.',
                `It has guides for: ${epgShareCountries().join(' ')}`,
                'tvinto guide suggest --country <code> gives one of them.'
              ],
              { country, suggestion: null, countries: epgShareCountries() }
            );
            return flags.country !== null ? 1 : 0;
          }
          if (flags.add) {
            const current = await acting();
            preview(current, await guideAddChange(current, await current.service.pull(), suggestion.url, suggestion.label));
            return 0;
          }
          print(
            [
              `${suggestion.label} (${suggestion.country}): ${suggestion.url}`,
              ...(suggestion.files.length > 1 ? [`Also for ${suggestion.country}: ${suggestion.files.slice(1).map(epgShareUrl).join(' ')}`] : []),
              `tvinto guide suggest --country ${suggestion.country} --add adds it.`
            ],
            { suggestion }
          );
          return 0;
        }
        const current = await acting();
        if (args[0] === 'add') {
          // The address is typed by a person: an Xtream guide's holds the login.
          if (!deps.terminal.isTTY) {
            throw new Error('A guide address is typed at a terminal: it can hold a provider login.');
          }
          const url = await deps.terminal.askHidden('Guide address (not shown): ');
          preview(current, await guideAddChange(current, await current.service.pull(), url, args.slice(1).join(' ')));
          return 0;
        }
        if (args[0] === 'channels' && args.length >= 2) {
          const guide = await guideNamed(current, await current.service.pull(), args[1]);
          const search = args.slice(2).join(' ').toLowerCase();
          const all = await guideChannels(guide, deps.fetch, { fresh: flags.fresh });
          const found = search
            ? all.filter(channel => channel.name.toLowerCase().includes(search) || channel.id.toLowerCase().includes(search))
            : all;
          const LIMIT = 100;
          const shown = found.slice(0, LIMIT).map(channel => ({ id: untrusted(channel.id), name: untrusted(channel.name) }));
          print(
            [
              ...(shown.length ? shown.map(channel => `${quoted(channel.id)}  ${quoted(channel.name)}`) : ['No channels found.']),
              ...(found.length > LIMIT ? [`... and ${found.length - LIMIT} more. Add a search to narrow it.`] : [])
            ],
            { guide: guide.id, channels: shown, total: found.length }
          );
          return 0;
        }
        if (args[0] === 'remove' && args.length === 2) {
          preview(current, await guideRemoveChange(current, await current.service.pull(), args[1]));
          return 0;
        }
        if ((args[0] !== 'on' && args[0] !== 'off') || !args[1] || args.length > 2) {
          throw new Error(
            'tvinto guide <on|off|remove> <id>, tvinto guide channels <id> [search], tvinto guide add [name], or tvinto guide suggest [--country <code>] [--add]. tvinto guides lists the ids.'
          );
        }
        preview(current, await guideChange(current, await current.service.pull(), args[1], args[0] === 'on'));
        return 0;
      }

      case 'order': {
        const type = typeOf(args[0]);
        if (args.length < 2) {
          throw new Error('tvinto order <live|movies|series> <id...>: these first, in this order.');
        }
        const current = await acting();
        const known = (await categories(current, type, deps.fetch)).categories;
        preview(current, orderChange(await current.service.pull(), type, known, args.slice(1)));
        return 0;
      }

      case 'recordings': {
        const current = await acting();
        const pulled = await current.service.pull();
        if (!args.length) {
          const view = recordingsView(pulled);
          const name = (key: string) => view.recorders.find(one => one.key === key)?.name ?? 'a device not heard from';
          const { beforeMin, afterMin, keepDays } = view.options;
          print(
            [
              ...(view.booked.length
                ? view.booked.map(one => `${one.id}  ${when(one.startMs)}  ${quoted(untrusted(one.title))} on channel ${one.channelId}, by ${quoted(untrusted(name(one.device)))}`)
                : ['Nothing booked.']),
              ...view.every.map(one => `${one.id}  every ${quoted(untrusted(one.title))} on channel ${one.channelId}, by ${quoted(untrusted(name(one.device)))}`),
              '',
              `Devices that record: ${view.recorders.length ? view.recorders.map(one => quoted(untrusted(one.name))).join(', ') : 'none yet'}`,
              `Starts ${beforeMin} min early, goes on ${afterMin} min after, kept ${keepDays === null ? 'until deleted' : `${keepDays} days`}.`
            ],
            view
          );
          return 0;
        }
        const [what, ...rest] = args;
        if (what === 'cancel' && rest.length === 1) {
          preview(current, cancelRecording(pulled, rest[0]));
        } else if (what === 'every') {
          preview(current, recordEvery(pulled, rest));
        } else if (what === 'stop-every' && rest.length === 1) {
          preview(current, stopEvery(pulled, rest[0]));
        } else if (what === 'book') {
          preview(current, bookRecording(pulled, rest));
        } else if (rest.length === 1) {
          preview(current, recordingOption(pulled, what, rest[0]));
        } else {
          throw new Error('tvinto recordings [book|cancel|before|after|keep] -- tvinto --help says how.');
        }
        return 0;
      }

      case 'player': {
        if (args.length !== 2) {
          throw new Error(`tvinto player <setting> <value>. ${PLAYER_HELP}`);
        }
        const current = await acting();
        preview(current, playerChange(await current.service.pull(), args[0], args[1]));
        return 0;
      }

      case 'descriptions': {
        if (args.length !== 1) {
          throw new Error(`tvinto descriptions <${DESCRIPTION_LANGUAGES.join('|')}>`);
        }
        const current = await acting();
        preview(current, descriptionsChange(await current.service.pull(), args[0]));
        return 0;
      }

      case 'preview': {
        if (args.length !== 1 || (args[0] !== 'on' && args[0] !== 'off')) {
          throw new Error('tvinto preview <on|off>');
        }
        const current = await acting();
        preview(current, previewChange(await current.service.pull(), args[0] === 'on'));
        return 0;
      }

      case 'languages': {
        if (!args.length) {
          throw new Error('tvinto languages <code...|default>, e.g. tvinto languages hr en');
        }
        const current = await acting();
        preview(current, languagesChange(await current.service.pull(), args));
        return 0;
      }

      case 'age-lock': {
        if (args.length < 1 || args.length > 2) {
          throw new Error('tvinto age-lock <off|12|16|18> [HR|DE|US|GB]');
        }
        const current = await acting();
        const pulled = await current.service.pull();
        const pinChecked = ageLockLoosens(pulled, args[0], args[1]) ? await askPin(pulled) : false;
        preview(current, ageLockChange(pulled, args[0], args[1], pinChecked));
        return 0;
      }

      case 'picture': {
        if (args.length !== 1) {
          throw new Error('tvinto picture <auto|animal|image file>');
        }
        const current = await session(deps.fetch, deps.store);
        preview(current, pictureChange(await current.service.pull(), await current.service.family(), pictureArgument(args[0])));
        return 0;
      }

      case 'last-channel': {
        if (args.length !== 1 || (args[0] !== 'on' && args[0] !== 'off')) {
          throw new Error('tvinto last-channel <on|off>');
        }
        const current = await acting();
        preview(current, lastChannelChange(await current.service.pull(), args[0] === 'on'));
        return 0;
      }

      case 'error-reports': {
        if (args.length !== 1 || (args[0] !== 'on' && args[0] !== 'off')) {
          throw new Error('tvinto error-reports <on|off>');
        }
        const current = await acting();
        preview(current, errorReportsChange(await current.service.pull(), args[0] === 'on'));
        return 0;
      }

      case 'apply': {
        if (args.length !== 1) {
          throw new Error('tvinto apply <code>, with the code a preview gave.');
        }
        const own = await session(deps.fetch, deps.store);
        const waiting = waitingFor();
        const member = waiting?.includes('/') ? waiting.slice(waiting.indexOf('/') + 1) : null;
        const done = await apply(member ? await memberSession(own, member, deps.store) : own, args[0]);
        print(
          [`Done${done.undo ? ' (undo)' : ''}:`, ...done.lines.map(render), 'Every device follows at its next sync. tvinto undo puts it back.'],
          { applied: done.lines }
        );
        return 0;
      }

      case 'undo': {
        const current = await acting();
        const last = await undoLast(current);
        if (!last) {
          print(['Nothing to undo.'], { undo: null });
          return 0;
        }
        preview(current, last.change, last.undoes);
        return 0;
      }

      case 'server': {
        if ((args[0] !== 'init' && args[0] !== 'tmdb-key') || args.length > 2) {
          throw new Error('tvinto server init [folder]  or  tvinto server tmdb-key [folder]');
        }
        // A person at a terminal, never an agent: wrangler signs in to
        // Cloudflare in a browser, and a deploy is theirs to make.
        if (!deps.terminal.isTTY || !deps.run) {
          throw new Error(`tvinto server ${args[0]} is run by a person, at a terminal.`);
        }
        if (args[0] === 'tmdb-key') {
          const terminal = deps.terminal;
          return await serverTmdbKey(args[1], {
            run: deps.run,
            fetch: deps.fetch,
            write: deps.write,
            askKey: () => terminal.askHidden('TMDB API key or read access token (not shown): ')
          });
        }
        return await serverInit(args[1], { run: deps.run, fetch: deps.fetch, write: deps.write });
      }
      case 'history': {
        const entries = history(await acting());
        print(
          entries.length
            ? entries.slice(0, 20).map(entry => `${entry.at.slice(0, 16).replace('T', ' ')}  ${entry.lines.map(render).join(' ')}`)
            : ['No changes made from here.'],
          { history: entries.map(entry => ({ at: entry.at, lines: entry.lines, undo: Boolean(entry.undoes) })) }
        );
        return 0;
      }

      default:
        deps.write(`tvinto: no command "${command}". tvinto --help lists them.\n`);
        return 1;
    }
  } catch (error) {
    deps.write(`tvinto: ${(error as Error).message}\n`);
    return 1;
  }
}
