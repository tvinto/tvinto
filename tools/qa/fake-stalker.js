#!/usr/bin/env node
/**
 * A stand-in Stalker (Ministra, "MAC") portal on this machine, for building
 * and testing portal support without anybody's subscription.
 * There is no published
 * specification; this answers the way real portals do as open-source players
 * know them -- iptvnator's mock portal (MIT) most of all -- including the
 * awkward parts a client has to survive:
 *
 * - the API is only at /stalker_portal/server/load.php: a client that tries
 *   /portal.php first gets 404 and has to look further;
 * - every request carries the MAC as a cookie (`mac=...`), and every one but
 *   the handshake a `Authorization: Bearer <token>` from it; anything else is
 *   answered 200 with the plain text "Authorization failed.", as portals do;
 * - a token stops working after --token-uses requests (default 40), so a
 *   client must notice and shake hands again;
 * - lists come 14 to a page (get_ordered_list, p=1..);
 * - a stream's address is made by create_link and works once.
 *
 * Every stream answers 404 unless --play names a local video: nothing plays.
 *
 *   node tools/qa/fake-stalker.js [--port 8770] [--token-uses 40] [--play <file>]
 *
 * In the app: Portal (MAC), address http://10.0.2.2:8770/c from an emulator
 * (http://127.0.0.1:8770/c on this machine), MAC 00:1A:79:00:00:01 -- a test
 * value for this server only.
 */

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const PORT = Number(arg('--port', 8770));
const TOKEN_USES = Number(arg('--token-uses', 40));
const PLAY = arg('--play', null);
const MAC = '00:1A:79:00:00:01';
const API = '/stalker_portal/server/load.php';
const PAGE = 14;

// --- The catalogue --------------------------------------------------------------
const liveGenres = [
  { id: '1', title: 'News', alias: 'news', censored: '0' },
  { id: '2', title: 'Sport', alias: 'sport', censored: '0' },
  { id: '3', title: 'A Genre With A Name Long Enough To Run Off Any Sidebar On Any Screen', alias: 'long', censored: '0' },
  { id: '4', title: 'Adult', alias: 'adult', censored: '1' }
];
const channels = [];
for (let i = 0; i < 60; i++) {
  const genre = liveGenres[i % 3].id;
  channels.push({
    id: String(100 + i), name: i === 7 ? 'HR| HRT 1 FHD' : `Channel ${i + 1}${i % 5 === 0 ? ' HD' : ''}`, number: String(i + 1),
    cmd: `ffrt http://localhost/ch/${100 + i}`, logo: '', tv_genre_id: genre, xmltv_id: `channel${i + 1}`,
    tv_archive: i % 4 === 0 ? 1 : 0, tv_archive_duration: i % 4 === 0 ? 72 : 0, censored: '0'
  });
}
channels.push({ id: '900', name: 'Adult Channel', number: '900', cmd: 'ffrt http://localhost/ch/900', logo: '', tv_genre_id: '4', xmltv_id: '', tv_archive: 0, censored: '1' });

const vodCategories = [
  { id: '11', title: 'Films', alias: 'films', censored: '0' },
  { id: '12', title: 'EN| 4K Films', alias: 'films-4k', censored: '0' }
];
const films = [];
for (let i = 0; i < 31; i++) {
  films.push({
    id: String(2000 + i), name: i === 0 ? 'The Matrix (1999)' : i === 1 ? 'EN - Dune (2021)' : `Film Number ${i + 1} (${2000 + i})`,
    o_name: '', cmd: Buffer.from(JSON.stringify({ type: 'movie', id: 2000 + i })).toString('base64'),
    category_id: i < 28 ? '11' : '12', screenshot_uri: '', description: 'A film that exists only on this machine.',
    year: String(2000 + i), rating_imdb: '7.1', time: '120', added: '2026-11-01 10:00:00', is_series: 0
  });
}
const seriesCategories = [{ id: '21', title: 'Drama', alias: 'drama', censored: '0' }];
const shows = [
  { id: '3000', name: 'Severance (2022)', seasons: 2, episodes: 9 },
  { id: '3001', name: 'Twelve Seasons', seasons: 12, episodes: 4 }
].map(show => ({ ...show, o_name: '', category_id: '21', screenshot_uri: '', description: 'A show that exists only on this machine.', year: '2022', is_series: 1, cmd: '' }));

// --- Sessions -------------------------------------------------------------------
/** token -> uses left. */
const tokens = new Map();

const cookieMac = req => /(?:^|;\s*)mac=([^;]+)/.exec(req.headers.cookie || '')?.[1];
const bearer = req => /^Bearer\s+(\S+)/.exec(req.headers.authorization || '')?.[1];

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function refuse(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('Authorization failed.');
}

function paged(res, list, page) {
  const p = Math.max(1, Number(page) || 1);
  json(res, { js: { total_items: list.length, max_page_items: PAGE, selected_item: 0, cur_page: p, data: list.slice((p - 1) * PAGE, p * PAGE) } });
}

/** Stream addresses made by create_link: each works once. */
const links = new Map();
function link(res, req, kind, id) {
  const once = crypto.randomBytes(8).toString('hex');
  links.set(once, kind);
  json(res, { js: { id: '1', cmd: `ffmpeg http://${req.headers.host}/play/${kind}/${id}.ts?once=${once}`, streamer_id: 0, load: 0, error: '' } });
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = url.searchParams;
    console.log(new Date().toISOString().slice(11, 19), url.pathname, q.get('type') ?? '', q.get('action') ?? '', q.get('p') ? `p=${q.get('p')}` : '');

    if (url.pathname.startsWith('/play/')) {
      const once = q.get('once');
      if (!once || !links.has(once)) {
        res.writeHead(403);
        return res.end();
      }
      links.delete(once);
      if (PLAY) {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        return fs.createReadStream(PLAY).pipe(res);
      }
      res.writeHead(404);
      return res.end();
    }
    if (url.pathname === '/c' || url.pathname === '/c/') {
      // The landing page a browser shows; people copy this address.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body>Portal</body></html>');
    }
    if (url.pathname !== API) {
      res.writeHead(404);
      return res.end();
    }
    if (cookieMac(req) !== encodeURIComponent(MAC) && cookieMac(req) !== MAC) {
      return refuse(res);
    }

    const type = q.get('type');
    const action = q.get('action');
    if (type === 'stb' && action === 'handshake') {
      const token = crypto.randomBytes(16).toString('hex').toUpperCase();
      tokens.set(token, TOKEN_USES);
      return json(res, { js: { token, random: crypto.randomBytes(20).toString('hex') } });
    }
    const token = bearer(req);
    const left = token ? tokens.get(token) : undefined;
    if (!left) {
      return refuse(res);
    }
    tokens.set(token, left - 1);

    if (type === 'stb' && action === 'get_profile') {
      return json(res, { js: { id: '42', name: 'walk', status: 0, login: '', fname: 'Test account', stb_type: 'MAG250', expire_billing_date: '2027-12-31 00:00:00', timezone: 'Europe/Zagreb' } });
    }
    if (type === 'account_info' && action === 'get_main_info') {
      return json(res, { js: { mac: MAC, phone: '', end_date: '2027-12-31 00:00:00', tariff_plan: 'Test' } });
    }
    if (type === 'itv' && action === 'get_genres') {
      return json(res, { js: [{ id: '*', title: 'All', alias: 'all', censored: '0' }, ...liveGenres] });
    }
    if (type === 'itv' && action === 'get_all_channels') {
      // As real portals do, the adult genre's channels are left out of "all".
      const shown = channels.filter(channel => channel.censored !== '1');
      return json(res, { js: { total_items: shown.length, max_page_items: shown.length, data: shown } });
    }
    if (type === 'itv' && action === 'get_ordered_list') {
      const genre = q.get('genre') ?? '*';
      return paged(res, channels.filter(channel => (genre === '*' ? channel.censored !== '1' : channel.tv_genre_id === genre)), q.get('p'));
    }
    if (type === 'itv' && action === 'get_short_epg') {
      const start = nowSeconds() - (nowSeconds() % 3600);
      return json(res, {
        js: [0, 1, 2, 3].map(i => ({
          id: String(i), ch_id: q.get('ch_id'), name: `Programme ${i + 1}`, descr: '', t_time: '', start_timestamp: start + i * 3600, stop_timestamp: start + (i + 1) * 3600
        }))
      });
    }
    if (type === 'itv' && action === 'create_link') {
      return link(res, req, 'live', /\/ch\/(\d+)/.exec(q.get('cmd') ?? '')?.[1] ?? '0');
    }
    if ((type === 'vod' || type === 'series') && action === 'get_categories') {
      return json(res, { js: [{ id: '*', title: 'All', alias: '*', censored: '0' }, ...(type === 'vod' ? vodCategories : seriesCategories)] });
    }
    if (type === 'vod' && action === 'get_ordered_list') {
      const category = q.get('category') ?? '*';
      return paged(res, films.filter(film => category === '*' || film.category_id === category), q.get('p'));
    }
    if (type === 'series' && action === 'get_ordered_list') {
      const movie = q.get('movie_id');
      if (movie) {
        // A show's seasons, each listing its episodes by number.
        const show = shows.find(one => one.id === movie);
        const seasons = show ? Array.from({ length: show.seasons }, (_, s) => ({
          id: `${show.id}:${s + 1}`, name: `Season ${s + 1}`, series: Array.from({ length: show.episodes }, (_, e) => e + 1),
          cmd: Buffer.from(JSON.stringify({ type: 'series', series_id: show.id, season_num: s + 1 })).toString('base64'), is_season: true
        })) : [];
        return paged(res, seasons, q.get('p'));
      }
      const category = q.get('category') ?? '*';
      return paged(res, shows.filter(show => category === '*' || show.category_id === category).map(({ seasons, episodes, ...show }) => show), q.get('p'));
    }
    if ((type === 'vod' || type === 'series') && action === 'create_link') {
      let cmd = {};
      try {
        cmd = JSON.parse(Buffer.from(q.get('cmd') ?? '', 'base64').toString('utf8'));
      } catch {
        // Not one of ours: a link to nothing.
      }
      const id = cmd.type === 'series' ? `${cmd.series_id}-${cmd.season_num}-${q.get('series') ?? '1'}` : String(cmd.id ?? 0);
      return link(res, req, cmd.type === 'series' ? 'episode' : 'film', id);
    }
    if (action === 'get_events' || action === 'set_fav') {
      return json(res, { js: { data: [] } });
    }
    return json(res, { js: { error: `Unknown action: ${action}` } });
}

if (require.main === module) {
  http.createServer(handle).listen(PORT, () => console.log(`fake Stalker portal on ${PORT}: MAC ${MAC}, API ${API}`));
}

/** For tests: a server on a free port, closed with close(). Logging stays off. */
module.exports.start = () =>
  new Promise(resolve => {
    console.log = () => undefined;
    const server = http.createServer(handle).listen(0, '127.0.0.1', () => resolve({ port: server.address().port, mac: MAC, close: () => server.close() }));
  });
