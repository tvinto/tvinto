#!/usr/bin/env node
/**
 * A stand-in Xtream provider on this machine, for walking the app
 * (tv-walk.js, phone-walk.js) on data that is nobody's subscription.
 *
 * The real provider allows one connection and must never be swept, and a
 * walk rests on channels -- which starts the guide's preview -- so a walk
 * against it plays things. This answers player_api.php and xmltv.php with
 * made-up channels, films and shows, worst cases included (long, spaceless,
 * emoji, Arabic and empty names; four hundred channels; a show of twelve
 * seasons and one of none), and answers every stream address with 404:
 * nothing can play.
 *
 *   node tools/qa/fake-xtream.js [--port 8767] [--play <local .ts file>] [--art <image address>] [--demo] [--slow <seconds>]
 *
 * --demo answers with demo-catalogue.js instead: a believable, invented
 * line-up with drawn posters and logos, for screenshots people will see.
 *
 * In the app: Xtream, server http://10.0.2.2:8767 from an emulator
 * (http://127.0.0.1:8767 on this machine), username and password both
 * "walk" -- test values for this server only.
 */

const http = require('http');

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8767;
/**
 * --slow <seconds>: a provider on a poor line, for seeing what the app shows
 * while it waits. The guide is sent in twenty pieces spread over that long,
 * and a whole library (a listing asked for with no category) is held back
 * for that long before it is answered.
 */
const SLOW_MS = process.argv.includes('--slow') ? Number(process.argv[process.argv.indexOf('--slow') + 1]) * 1000 : 0;
/** --play <file>: a local video every stream address answers with, instead of 404. */
const PLAY = process.argv.includes('--play') ? process.argv[process.argv.indexOf('--play') + 1] : null;
/**
 * --play-kbps <n>: that video sent no faster than this, as over a real line,
 * so a player's cache fills slowly and a request is still sending when the
 * next one starts. Unpaced without it.
 */
const PLAY_KBPS = process.argv.includes('--play-kbps') ? Number(process.argv[process.argv.indexOf('--play-kbps') + 1]) : 0;

/** The file's bytes from start to end into the response, paced by --play-kbps. */
function sendFile(res, options) {
  const file = require('fs').createReadStream(PLAY, { ...options, highWaterMark: 64 * 1024 });
  if (!PLAY_KBPS) {
    return file.pipe(res);
  }
  res.on('close', () => file.destroy());
  file.on('data', chunk => {
    file.pause();
    res.write(chunk);
    setTimeout(() => file.resume(), (chunk.length * 8) / PLAY_KBPS);
  });
  return file.on('end', () => res.end());
}

/**
 * --live <file.ts>: live channels answer with this MPEG-TS clip sent over and
 * over without end, at about the pace it plays (--live-kbps, default 2000),
 * as a broadcast does -- for recording, which keeps a channel open for as
 * long as a programme lasts. And like a subscription that allows one
 * connection (`max_connections` says 1), a second stream while one is open is
 * refused with 403: what recording and multi-view must never cause.
 */
const LIVE = process.argv.includes('--live') ? process.argv[process.argv.indexOf('--live') + 1] : null;
const LIVE_KBPS = Number(process.argv.includes('--live-kbps') ? process.argv[process.argv.indexOf('--live-kbps') + 1] : 2000);
let openStreams = 0;
let openRequests = 0;

/**
 * --live-hls <folder>: the .m3u8 address answers live HLS made from the
 * segments in this folder (an index.m3u8 and its pieces, as ffmpeg's hls
 * muxer writes them from the --live clip), played round and round with the
 * clock, a discontinuity where the clip starts again -- as a broadcast's
 * playlist moves on. Pieces are separate requests, so they are not counted
 * against the one connection. Without it, .m3u8 answers like .ts, which a
 * player expecting HLS refuses.
 *
 * It also answers /playlist.m3u, an M3U playlist (not Xtream) of two HLS-only
 * channels on the same pieces: /hls/1.m3u8, a media playlist, and
 * /hls/2/master.m3u8, a master playlist of two variants. These are what a
 * pause fetches piece by piece; every stream request is logged with how many
 * were open at once, which must never be more than one while a pause writes.
 */
const LIVE_HLS = process.argv.includes('--live-hls') ? process.argv[process.argv.indexOf('--live-hls') + 1] : null;
const hlsPieces = () => {
  const index = require('fs').readFileSync(require('path').join(LIVE_HLS, 'index.m3u8'), 'utf8').split('\n').map(line => line.trim());
  const pieces = [];
  index.forEach((line, at) => {
    const length = /^#EXTINF:([\d.]+)/.exec(line)?.[1];
    if (length) {
      pieces.push({ seconds: Number(length), file: index[at + 1].trim() });
    }
  });
  return pieces;
};

/**
 * Faults for the live HLS, to see what a player does with a provider's
 * hiccups (a desktop channel stopped every minute or so, 12 November). Set
 * while it runs:
 *
 *   /qa/fault?playlist=fail&times=1     the next playlist reload answers 500
 *   /qa/fault?playlist=gone&times=1     ... 404
 *   /qa/fault?playlist=slow&ms=8000     the next reload waits that long first
 *   /qa/fault?playlist=hang&times=1     the next reload never answers
 *   /qa/fault?playlist=stale&times=3    the next reloads repeat the last one
 *   /qa/fault?playlist=skip&times=1     the next reload jumps 4 pieces ahead
 *   /qa/fault?segment=fail&times=1      the next piece answers 500
 *   /qa/fault?cut=1                     closes every open stream request
 *   /qa/fault?live=hang                 every live channel answers 200 and sends nothing, until cleared
 *   /qa/fault                           clears them all
 *
 * And /qa/count says how many stream requests were made, and the most ever
 * open at once, since the last /qa/count?reset=1. Films and episodes count
 * as stream requests too.
 *
 * /qa/requests lists each of those requests since the last reset: when it
 * started and ended (ms since the reset), the range it asked for, the bytes
 * sent, and which other requests were open at the same moment (`overlaps`,
 * with how many ms they shared). For seeing whether a player ever holds two
 * connections to a provider that allows one (a subtitle chosen mid-film, 22
 * November). It is reset with /qa/count.
 */
const fault = { live: null, playlist: null, segment: null, ms: 0, times: 0, segmentTimes: 0 };
let lastPlaylist = null;
let skipAhead = 0;
const counts = { playlists: 0, segments: 0, streams: 0, mostOpen: 0 };
let requestLog = [];
let requestClock = performance.now();
const since = moment => Math.round((moment - requestClock) * 10) / 10;

/**
 * One stream request into /qa/requests. Its times are its connection's: from
 * when the socket was accepted to when it closed, to a tenth of a millisecond,
 * because that is what a provider counting connections sees -- a response can
 * end while its socket is still open.
 */
function logRequest(req, res, path) {
  const socket = req.socket;
  const entry = {
    n: requestLog.length + 1, path, range: req.headers.range ?? null, port: socket.remotePort,
    start: since(socket.acceptedAt ?? performance.now()), end: null, bytes: 0
  };
  requestLog.push(entry);
  const before = socket.bytesWritten;
  res.on('close', () => {
    entry.bytes = socket.bytesWritten - before;
  });
  const closed = () => {
    entry.end = since(performance.now());
  };
  if (socket.destroyed) {
    closed();
  } else {
    socket.once('close', closed);
  }
}

/** The request log, each with the others it was open at the same time as. */
function requestsWithOverlaps() {
  const now = since(performance.now());
  return requestLog.map(entry => {
    const end = entry.end ?? now;
    const overlaps = requestLog
      .filter(other => other !== entry && other.port !== entry.port && other.start < end && (other.end ?? now) > entry.start)
      .map(other => ({ n: other.n, ms: Math.round((Math.min(end, other.end ?? now) - Math.max(entry.start, other.start)) * 10) / 10 }));
    return { ...entry, open: entry.end === null, overlaps };
  });
}
const openSockets = new Set();

function serveFault(q, res) {
  if (q.get('cut')) {
    for (const socket of openSockets) {
      socket.destroy();
    }
  }
  fault.live = q.get('live');
  fault.playlist = q.get('playlist');
  fault.segment = q.get('segment');
  fault.ms = Number(q.get('ms') ?? 0);
  fault.times = Number(q.get('times') ?? 1);
  fault.segmentTimes = Number(q.get('times') ?? 1);
  console.log('fault:', JSON.stringify(fault));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(fault));
}

/** Whether a playlist request is answered by a fault instead; true when it was. */
function playlistFault(pathname, res) {
  if (!fault.playlist || fault.times <= 0) {
    return false;
  }
  const kind = fault.playlist;
  if (kind !== 'slow') {
    fault.times--;
  } else {
    fault.playlist = null;
  }
  console.log('fault: playlist', kind);
  if (kind === 'fail' || kind === 'gone') {
    res.writeHead(kind === 'fail' ? 500 : 404);
    res.end();
    return true;
  }
  if (kind === 'hang') {
    return true;
  }
  if (kind === 'slow') {
    setTimeout(() => serveLivePlaylist(pathname, res), fault.ms);
    return true;
  }
  if (kind === 'stale' && lastPlaylist) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    res.end(lastPlaylist);
    return true;
  }
  if (kind === 'skip') {
    skipAhead += 4;
  }
  return false;
}

function serveLivePlaylist(pathname, res) {
  const pieces = hlsPieces();
  const seconds = Math.max(1, Math.round(pieces.reduce((all, piece) => all + piece.seconds, 0) / pieces.length));
  const newest = Math.floor(Date.now() / 1000 / seconds) + skipAhead;
  const first = newest - 5;
  const base = pathname.replace(/\.m3u8$/, '');
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...pieces.map(piece => piece.seconds)))}`,
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / pieces.length)}`
  ];
  for (let seq = first; seq <= newest; seq++) {
    const piece = pieces[seq % pieces.length];
    if (seq % pieces.length === 0 && seq !== first) {
      lines.push('#EXT-X-DISCONTINUITY');
    }
    lines.push(`#EXTINF:${piece.seconds.toFixed(3)},`, `${base}/seg-${seq}.ts`);
  }
  res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  res.end(`${lines.join('\n')}\n`);
}

/** The M3U playlist of HLS-only channels: what a provider that is not Xtream gives. */
function serveM3u(host, res) {
  const lines = [
    '#EXTM3U',
    `#EXTINF:-1 tvg-id="hls1" group-title="HLS",HLS media playlist`,
    `http://${host}/hls/1.m3u8`,
    `#EXTINF:-1 tvg-id="hls2" group-title="HLS",HLS master playlist`,
    `http://${host}/hls/2/master.m3u8`
  ];
  res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
  res.end(`${lines.join('\n')}\n`);
}

/** A master playlist of two variants, both on the same pieces. */
function serveMaster(pathname, res) {
  const base = pathname.replace(/\/master\.m3u8$/, '');
  const lines = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    `${base}/low.m3u8`,
    '#EXT-X-STREAM-INF:BANDWIDTH=1700000,RESOLUTION=1280x720',
    `${base}/high.m3u8`
  ];
  res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  res.end(`${lines.join('\n')}\n`);
}

function serveLiveSegment(pathname, res) {
  if (fault.segment === 'fail' && fault.segmentTimes > 0) {
    fault.segmentTimes--;
    console.log('fault: segment fail');
    res.writeHead(500);
    return res.end();
  }
  const pieces = hlsPieces();
  const seq = Number(/seg-(\d+)\.ts$/.exec(pathname)[1]);
  const body = require('fs').readFileSync(require('path').join(LIVE_HLS, pieces[seq % pieces.length].file));
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': body.length });
  res.end(body);
}

function serveLive(req, res) {
  if (openStreams >= 1) {
    console.log('refused: a second stream while one is open');
    res.writeHead(403);
    return res.end();
  }
  openStreams++;
  const clip = require('fs').readFileSync(LIVE);
  // A tenth of a second's worth, ten times a second, aligned to 188-byte TS packets.
  const piece = Math.max(188, Math.floor((LIVE_KBPS * 1000) / 8 / 10 / 188) * 188);
  let at = 0;
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  const timer = setInterval(() => {
    // Round and round the clip, without end.
    const chunk = Buffer.alloc(piece);
    for (let filled = 0; filled < piece; ) {
      const take = Math.min(piece - filled, clip.length - at);
      clip.copy(chunk, filled, at, at + take);
      filled += take;
      at = (at + take) % clip.length;
    }
    res.write(chunk);
  }, 100);
  const done = () => {
    clearInterval(timer);
    openStreams = Math.max(0, openStreams - 1);
  };
  req.on('close', done);
  res.on('error', done);
}
/** --art <address>: an image every film and show has as its poster, to see the pages with pictures. */
const ART = process.argv.includes('--art') ? process.argv[process.argv.indexOf('--art') + 1] : '';
const USER = 'walk';

const LONG = 'The Extraordinarily Long Channel Name That Goes On And On Well Past Where Any Card Could Hold It HD 4K UHD';
const NOSPACE = 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS_CHANNEL_WITHOUT_ANY_SPACES_AT_ALL_1234567890_ABCDEFGHIJKLMNOP';
const LONG_GROUP = 'A Category Whose Name Is So Long That It Runs Past The Sidebar, The Header And Probably The Whole Screen Too';
const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');
const sentence = n => Array.from({ length: n }, (_, i) => words[(i * 7) % words.length]).join(' ');
const added = String(Math.floor(Date.now() / 1000) - 86400);

const liveCategories = [
  { category_id: '1', category_name: 'HR| Sport', parent_id: 0 },
  { category_id: '2', category_name: 'Edge cases', parent_id: 0 },
  { category_id: '3', category_name: LONG_GROUP, parent_id: 0 },
  { category_id: '4', category_name: 'Four hundred channels', parent_id: 0 }
];
const live = [];
const channel = (category, name, epg) => live.push({
  num: live.length + 1, name, stream_type: 'live', stream_id: 1000 + live.length, stream_icon: '',
  epg_channel_id: epg ?? `ch${live.length}`, added, category_id: category, tv_archive: 0, tv_archive_duration: 0
});
['Arena Sport 1 HD', 'Arena Sport 2 HD', 'Sportklub 1', 'Eurosport 1 Hrvatska', 'HRT 2 ⱽᴵᴾ ᴿᴬᵂ'].forEach(name => channel('1', name));
[LONG, NOSPACE, '', '📺🔥⚽🎬🎵📰', 'قناة الجزيرة الوثائقية الطويلة جدا', 'Ελληνική Ραδιοφωνία Τηλεόραση Πρώτο Πρόγραμμα', 'Hrvatska radiotelevizija – Šđčćž ŠĐČĆŽ', 'X'].forEach(name => channel('2', name));
channel('3', 'In the long category');
for (let i = 1; i <= 400; i++) channel('4', `Channel number ${i} of four hundred`, i <= 10 ? undefined : '');

const vodCategories = [
  { category_id: '11', category_name: 'Films', parent_id: 0 },
  { category_id: '12', category_name: 'EN| 4K Films', parent_id: 0 }
];
const vod = [
  'The Matrix (1999)', 'Dune (2021)', 'Normal Film (2025)', '',
  'A Film With A Title So Long It Needs Three Lines On A Poster And Still Does Not Fit Anywhere (2026)',
  'FILMWITHOUTANYSPACESINITSTITLEWHATSOEVERANDQUITELONGTOO', 'Ω'
].map((name, i) => ({
  num: i + 1, name, stream_type: 'movie', stream_id: 2000 + i, stream_icon: ART, rating: '7.1', added,
  category_id: '11', container_extension: 'mkv'
}));
// A film whose description is cut on every screen.
vod.find(film => film.name === 'Normal Film (2025)').plot = sentence(150);
vod.push({ num: 8, name: '[4K] Dune (2021)', stream_type: 'movie', stream_id: 2100, stream_icon: '', rating: '8', added, category_id: '12', container_extension: 'mkv' });

// One film three times, for trying another copy when one fails: the first is
// gone (404), the second plays when --play names a video, and the third is
// refused the way a provider turns an account away (403), which must stop
// the app trying copies.
const COPY_GONE = 2201;
const COPY_REFUSED = 2203;
vod.push(
  ...[
    [COPY_GONE, 'EN - Spare Copy FHD (2020)'],
    [2202, 'EN - Spare Copy 1080p (2020)'],
    [COPY_REFUSED, 'DE - Spare Copy FHD (2020)']
  ].map(([stream_id, name], i) => ({
    num: 9 + i, name, stream_type: 'movie', stream_id, stream_icon: '', rating: '6', added, category_id: '12', container_extension: 'mkv'
  }))
);

// What a provider adds in a week: each title in several copies at once -- 4K
// and HD, another language -- so Recently added and every row of a library's
// front page must show one card per title (The Odyssey twice in a row on a
// user's Movies, 14 November). Newer than everything else, so they lead it.
vodCategories.push({ category_id: '13', category_name: 'EN| New releases', parent_id: 0 });
[
  ['EN - The Odyssey 4K (2026)', 'EN - The Odyssey HD (2026)', 'DE - The Odyssey (2026)'],
  ['EN - Fall 2 4K (2026)', 'EN - Fall 2 (2026)'],
  ['EN - Other Mommy (2026)', 'EN - Other Mommy FHD (2026)'],
  ['EN - Never Surrender (2026)', 'HR - Never Surrender (2026)'],
  ['EN - Quiet Harbour (2025)']
].forEach((copies, title) =>
  copies.forEach((name, copy) =>
    vod.push({
      num: vod.length + 1, name, stream_type: 'movie', stream_id: 2300 + title * 10 + copy, stream_icon: ART, rating: '7', category_id: '13',
      container_extension: 'mkv', added: String(Math.floor(Date.now() / 1000) - title * 3600 - copy * 60)
    })
  )
);

const seriesCategories = [
  { category_id: '21', category_name: 'Drama', parent_id: 0 },
  { category_id: '22', category_name: 'Comedy', parent_id: 0 }
];
const series = [
  { name: 'Severance (2022)', seasons: 2, episodes: 9 },
  { name: 'A Show Whose Title Goes On For Far Longer Than Any Poster Could Ever Hope To Hold (2020)', seasons: 1, episodes: 3 },
  // A description long enough to be cut on every screen, and longer than a
  // television's reader holds without scrolling.
  { name: 'Twelve Seasons', seasons: 12, episodes: 4, plot: sentence(260) },
  { name: 'No Episodes Yet', seasons: 0, episodes: 0 },
  // One show twice, for trying another copy when an episode fails.
  { name: 'EN - Spare Show FHD (2021)', seasons: 1, episodes: 3 },
  { name: 'EN - Spare Show HD (2021)', seasons: 1, episodes: 3 },
  // One show in three copies with different seasons, for the seasons
  // gathered across copies (22 November): the 4K copy has seasons 1-2, the HD
  // one 1-3 without the newest episode, the German one only season 3, with a
  // gap where the HD one ends. fake-tmdb.js says season 3 has six episodes.
  { name: 'EN - Ring Saga 4K (2022)', tmdb: '9203', layout: { 1: [1, 2, 3], 2: [1, 2, 3] } },
  { name: 'EN - Ring Saga HD (2022)', tmdb: '9203', layout: { 1: [1, 2, 3], 2: [1, 2, 3], 3: [1, 2, 3, 4, 5] } },
  { name: 'DE - Ring Saga (2022)', tmdb: '9203', layout: { 3: [1, 2, 3, 4, 6] } }
].map((show, i) => ({
  ...show, num: i + 1, series_id: 3000 + i, cover: ART, plot: show.plot ?? sentence(30), cast: 'Somebody, Somebody Else', director: '',
  genre: 'Drama', releaseDate: '2022-02-18', last_modified: added, rating: '8', rating_5based: 4, backdrop_path: [],
  youtube_trailer: '', episode_run_time: '50', category_id: i === 2 ? '22' : '21'
}));

const DEMO = process.argv.includes('--demo') ? require('./demo-catalogue') : null;
const data = DEMO ?? { liveCategories, live, vodCategories, vod, seriesCategories, series };

const seriesInfo = id => {
  const show = data.series.find(entry => String(entry.series_id) === String(id));
  if (!show) return { info: {}, episodes: {}, seasons: [] };
  const episodes = {};
  // `layout` names each season's episode numbers; otherwise every season has `episodes` of them.
  const layout = show.layout ?? Object.fromEntries(Array.from({ length: show.seasons }, (_, s) => [s + 1, Array.from({ length: show.episodes }, (_, e) => e + 1)]));
  for (const [season, numbers] of Object.entries(layout)) {
    const s = Number(season);
    episodes[String(s)] = numbers.map(number => number - 1).map(e => ({
      id: String(show.series_id * 100 + s * 20 + e), episode_num: e + 1, season: s, container_extension: 'mkv',
      title: DEMO
        ? DEMO.episodeTitle(show, s, e + 1)
        : e === 1 ? `${show.name} - S${s}E${e + 1} - An Episode Title That Keeps Going Well Past The End Of Any Row` : `${show.name} - S${s}E${e + 1}`,
      info: { duration_secs: 3000, duration: '00:50:00', plot: DEMO ? DEMO.episodePlot(show, e + 1) : e === 0 ? sentence(60) : '', video: { duration: '00:50:00' } }
    }));
  }
  const { seasons: _seasons, episodes: _count, layout: _layout, ...info } = show;
  return { info, episodes, seasons: Object.keys(layout).map(s => ({ season_number: Number(s), name: `Season ${s}` })) };
};

const vodInfo = id => {
  const film = data.vod.find(entry => String(entry.stream_id) === String(id));
  const backdrop = DEMO ? [film?.stream_icon.replace('poster', 'backdrop')] : [];
  return film
    ? { info: { name: film.name, plot: film.plot ?? sentence(40), duration_secs: 7200, duration: '02:00:00', genre: 'Drama', backdrop_path: backdrop, releasedate: film.year ? `${film.year}-05-01` : '', rating: film.rating, movie_image: film.stream_icon }, movie_data: { stream_id: film.stream_id, name: film.name, container_extension: 'mkv' } }
    : { info: [], movie_data: {} };
};

function xmltv() {
  const pad = n => String(n).padStart(2, '0');
  const time = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const start = new Date();
  start.setUTCMinutes(0, 0, 0);
  start.setUTCHours(start.getUTCHours() - 2);
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';
  const guided = data.live.filter(entry => entry.epg_channel_id);
  for (const entry of guided) xml += `  <channel id="${entry.epg_channel_id}"><display-name>${esc(entry.name || 'Unnamed')}</display-name></channel>\n`;
  for (const entry of guided) {
    let at = new Date(start);
    const end = new Date(start.getTime() + 14 * 3600000);
    for (let i = 0; DEMO && at < end; i++) {
      const programme = DEMO.programmeOf(entry, i);
      const to = new Date(at.getTime() + programme.minutes * 60000);
      xml += `  <programme start="${time(at)}" stop="${time(to)}" channel="${entry.epg_channel_id}"><title>${esc(programme.title)}</title><desc>${esc(programme.desc)}</desc></programme>\n`;
      at = to;
    }
    for (let i = 0; !DEMO && at < end; i++) {
      const minutes = entry.name === NOSPACE ? 5 : entry.name.startsWith('📺') ? 720 : 30 + (i % 3) * 15;
      const title = entry.name === LONG ? 'A programme title of two hundred characters, '.repeat(5).slice(0, 200) : `Programme ${i + 1}: ${sentence(3 + (i % 5))}`;
      const to = new Date(at.getTime() + minutes * 60000);
      xml += `  <programme start="${time(at)}" stop="${time(to)}" channel="${entry.epg_channel_id}"><title>${esc(title)}</title><desc>${esc(sentence(entry.name === LONG ? 330 : 25))}</desc></programme>\n`;
      at = to;
    }
  }
  return xml + '</tv>\n';
}

/** The demo's pictures are addressed as ART/...; they are served from wherever the app reached this. */
let artBase = '';
const json = (res, body) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body).split('"ART/').join(`"${artBase}/art/`));
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = url.searchParams;
    // Stream requests (a playlist or a piece) say how many were open at once.
    const stream = /^\/(hls|live|movie|series)\//.test(url.pathname);
    if (stream) {
      logRequest(req, res, url.pathname);
      openRequests++;
      counts.streams++;
      counts.mostOpen = Math.max(counts.mostOpen, openRequests);
      if (/\.m3u8$/.test(url.pathname)) {
        counts.playlists++;
      } else if (/seg-\d+\.ts$/.test(url.pathname)) {
        counts.segments++;
      }
      openSockets.add(req.socket);
      res.on('close', () => {
        openRequests--;
        openSockets.delete(req.socket);
      });
    }
    if (url.pathname === '/qa/fault') {
      return serveFault(q, res);
    }
    if (url.pathname === '/qa/count') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...counts, openNow: openRequests }));
      if (q.get('reset')) {
        Object.assign(counts, { playlists: 0, segments: 0, streams: 0, mostOpen: openRequests });
        requestLog = [];
        requestClock = performance.now();
      }
      return undefined;
    }
    if (url.pathname === '/qa/requests') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(requestsWithOverlaps(), null, 1));
    }
    console.log(new Date().toISOString().slice(11, 23), url.pathname, q.get('action') ?? '', q.get('series_id') ?? '', stream ? `open=${openRequests}${openRequests > 1 ? ' OVERLAP' : ''} range=${req.headers.range ?? 'none'}` : '');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
      return res.end();
    }
    artBase = `http://${req.headers.host}`;
    if (DEMO && url.pathname.startsWith('/art/')) {
      const svg = DEMO.art(url.pathname.slice('/art/'.length));
      res.writeHead(svg ? 200 : 404, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600', 'Access-Control-Allow-Origin': '*' });
      return res.end(svg ?? '');
    }
    if (url.pathname.endsWith('/xmltv.php')) {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      if (SLOW_MS) {
        const body = Buffer.from(xmltv());
        const pieces = 20;
        const size = Math.ceil(body.length / pieces);
        let piece = 0;
        const next = () => {
          if (res.destroyed) return;
          res.write(body.subarray(piece * size, (piece + 1) * size));
          piece++;
          if (piece < pieces) setTimeout(next, SLOW_MS / pieces);
          else res.end();
        };
        return next();
      }
      return res.end(xmltv());
    }
    if (!url.pathname.endsWith('/player_api.php')) {
      // Every stream address: nothing plays -- unless --play names a local
      // video, served for every film, episode and channel alike, for checking
      // the player against the app's own path (a resumed episode, 29 October).
      // A channel that never starts: the connection opens and nothing comes (23 November).
      if (fault.live === 'hang' && /\/live\//.test(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        return undefined;
      }
      const film = /\/movie\/[^/]+\/[^/]+\/(\d+)\./.exec(url.pathname)?.[1];
      if (Number(film) === COPY_GONE || Number(film) === COPY_REFUSED) {
        res.writeHead(Number(film) === COPY_GONE ? 404 : 403);
        return res.end();
      }
      if (LIVE_HLS && /\/live\/[^/]+\/[^/]+\/\d+\.m3u8$/.test(url.pathname)) {
        return playlistFault(url.pathname, res) ? undefined : serveLivePlaylist(url.pathname, res);
      }
      if (LIVE_HLS && /^\/(live\/[^/]+\/[^/]+|hls)\/.*\/seg-\d+\.ts$/.test(url.pathname)) {
        return serveLiveSegment(url.pathname, res);
      }
      if (LIVE_HLS && url.pathname === '/playlist.m3u') {
        return serveM3u(req.headers.host, res);
      }
      if (LIVE_HLS && /^\/hls\/\d+\/master\.m3u8$/.test(url.pathname)) {
        return serveMaster(url.pathname, res);
      }
      if (LIVE_HLS && /^\/hls\/\d+(\/(low|high))?\.m3u8$/.test(url.pathname)) {
        return playlistFault(url.pathname, res) ? undefined : serveLivePlaylist(url.pathname, res);
      }
      if (LIVE && /\/live\/[^/]+\/[^/]+\/\d+\.(ts|m3u8)$/.test(url.pathname)) {
        return serveLive(req, res);
      }
      if (PLAY) {
        const size = require('fs').statSync(PLAY).size;
        // Byte ranges as a provider's server answers them, so a resumed film
        // starts where it was and a seek lands (a player asks for one range).
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        if (range && (range[1] || range[2])) {
          const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
          const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
          if (start >= size || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            return res.end();
          }
          res.writeHead(206, {
            'Content-Type': 'video/mp2t',
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes'
          });
          return sendFile(res, { start, end });
        }
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
        return sendFile(res, {});
      }
      res.writeHead(404);
      return res.end();
    }
    if (q.get('username') !== USER || q.get('password') !== USER) {
      return json(res, { user_info: { auth: 0 } });
    }
    const category = q.get('category_id');
    const action = q.get('action');
    if (SLOW_MS && !category && ['get_live_streams', 'get_vod_streams', 'get_series'].includes(action)) {
      return setTimeout(() => answer(), SLOW_MS);
    }
    return answer();
    function answer() {
    const inCategory = list => (category ? list.filter(entry => entry.category_id === category) : list);
    switch (action) {
      case null:
        return json(res, {
          user_info: { username: USER, password: USER, message: '', auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 365 * 86400), is_trial: '0', active_cons: '0', created_at: added, max_connections: '1', allowed_output_formats: ['m3u8', 'ts'] },
          server_info: { url: url.hostname, port: String(PORT), https_port: '', server_protocol: 'http', rtmp_port: '', timezone: 'Europe/Zagreb', timestamp_now: Math.floor(Date.now() / 1000), time_now: new Date().toISOString().slice(0, 19).replace('T', ' ') }
        });
      case 'get_live_categories': return json(res, data.liveCategories);
      case 'get_vod_categories': return json(res, data.vodCategories);
      case 'get_series_categories': return json(res, data.seriesCategories);
      case 'get_live_streams': return json(res, inCategory(data.live));
      case 'get_vod_streams': return json(res, inCategory(data.vod).map(({ plot, year, ...film }) => film));
      case 'get_series': return json(res, inCategory(data.series).map(({ seasons, episodes, layout, ...show }) => show));
      case 'get_series_info': return json(res, seriesInfo(q.get('series_id')));
      case 'get_vod_info': return json(res, vodInfo(q.get('vod_id')));
      case 'get_short_epg':
      case 'get_simple_data_table': return json(res, { epg_listings: [] });
      default: return json(res, []);
    }
    }
  })
  .on('connection', socket => {
    socket.acceptedAt = performance.now();
  })
  .listen(PORT, () => console.log(`fake Xtream on ${PORT}: user and password "${USER}"`));
