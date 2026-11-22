#!/usr/bin/env node
/**
 * A stand-in for TMDB's API on this machine, for seeing the TMDB parts of the
 * app (Movies' and TV Shows' rows, For You's Popular, the full lists) without
 * a real key and without asking TMDB anything.
 *
 *   node tools/qa/fake-tmdb.js --port <port>        (a server)
 *   require('./fake-tmdb').answer(url)             (no server at all)
 *
 * It answers TMDB's https://api.themoviedb.org/3/... with titles that
 * fake-xtream.js holds -- the films added in several copies among them --
 * and a few it does not, which must never show. Any key is taken. The app
 * asks TMDB's own address, so a test answers those requests itself through
 * DevTools' Fetch domain, with `answer`, which needs no port.
 */

const http = require('http');


const film = (id, title, year, genres) => ({ id, title, original_title: title, release_date: `${year}-06-01`, genre_ids: genres, poster_path: '', backdrop_path: '', overview: `${title}, as the stand-in tells it.`, vote_average: 7.4, vote_count: 3000 });
const show = (id, name, year, genres) => ({ id, name, original_name: name, first_air_date: `${year}-02-18`, genre_ids: genres, poster_path: '', backdrop_path: '', overview: `${name}, as the stand-in tells it.`, vote_average: 8.1, vote_count: 900 });

// In the fake library: the films added in copies, and the older ones.
const odyssey = film(9001, 'The Odyssey', 2026, [12, 28]);
const fall = film(9002, 'Fall 2', 2026, [53]);
const mommy = film(9003, 'Other Mommy', 2026, [27]);
const surrender = film(9004, 'Never Surrender', 2026, [28]);
const harbour = film(9005, 'Quiet Harbour', 2025, [18]);
const matrix = film(603, 'The Matrix', 1999, [28, 878]);
const dune = film(438631, 'Dune', 2021, [878, 12]);
const spare = film(9006, 'Spare Copy', 2020, [18]);
// Not in the library: a row must leave these out.
const missing = [film(9100, 'Nowhere To Be Found', 2026, [28]), film(9101, 'Absent Friends', 2025, [18])];

const severance = show(95396, 'Severance', 2022, [18, 9648]);
const spareShow = show(9201, 'Spare Show', 2021, [18]);
const twelve = show(9202, 'Twelve Seasons', 2015, [35]);
const missingShow = show(9300, 'Never Made', 2024, [18]);

const lists = {
  movie: {
    trending: [odyssey, missing[0], fall, matrix, mommy, dune],
    popular: [dune, odyssey, surrender, missing[1], matrix, fall, mommy],
    top: [matrix, dune, harbour, spare, missing[0]],
    new: [odyssey, fall, mommy, surrender, harbour, missing[1]],
    genre: [matrix, dune, odyssey, surrender, fall, spare]
  },
  tv: {
    trending: [severance, missingShow, spareShow],
    popular: [spareShow, severance, twelve],
    top: [severance, twelve, missingShow],
    new: [severance, spareShow],
    genre: [severance, spareShow, twelve]
  }
};

const genres = {
  movie: [[28, 'Action'], [12, 'Adventure'], [18, 'Drama'], [27, 'Horror'], [878, 'Science Fiction'], [53, 'Thriller']],
  tv: [[18, 'Drama'], [35, 'Comedy'], [9648, 'Mystery']]
};

const page = results => ({ page: 1, results, total_pages: 1, total_results: results.length });
const all = [...Object.values(lists.movie).flat(), ...Object.values(lists.tv).flat()];

/** Which list a request is, by TMDB's own addresses (shared/tmdb/client.ts, listRequest). */
function listOf(kind, path, q) {
  if (path === `/trending/${kind}/week`) return 'trending';
  if (path === `/${kind}/popular`) return 'popular';
  if (path === `/discover/${kind}`) {
    if (q.get('with_genres')) return 'genre';
    if (q.get('release_date.gte') || q.get('first_air_date.gte')) return 'new';
    return 'top';
  }
  return null;
}

/** TMDB's answer to one address: { status, body }. */
function answer(address) {
  const url = new URL(address, 'http://x');
  const path = url.pathname.replace(/^\/3/, '');
  const send = (status, body) => ({ status, body });
  if (path === '/configuration') return send(200, { images: {} });
  for (const kind of ['movie', 'tv']) {
    const list = listOf(kind, path, url.searchParams);
    if (list) return send(200, page(url.searchParams.get('page') > 1 ? [] : lists[kind][list]));
    if (path === `/genre/${kind}/list`) return send(200, { genres: genres[kind].map(([id, name]) => ({ id, name })) });
    if (path === `/search/${kind}`) {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      const key = kind === 'movie' ? 'title' : 'name';
      return send(200, page([...new Map(all.filter(one => one[key]?.toLowerCase() === query).map(one => [one.id, one])).values()]));
    }
    const detail = new RegExp(`^/${kind}/([0-9]+)(/.*)?$`).exec(path);
    if (detail) {
      const one = all.find(entry => entry.id === Number(detail[1]) && (kind === 'movie' ? entry.title : entry.name));
      if (!one) return send(404, { status_message: 'not found' });
      const names = genres[kind];
      return send(200, {
        ...one, runtime: 120, number_of_seasons: 2, genres: one.genre_ids.map(id => ({ id, name: names.find(([g]) => g === id)?.[1] ?? '' })),
        release_dates: { results: [] }, content_ratings: { results: [] }, recommendations: { results: [] }, videos: { results: [] }, episodes: []
      });
    }
  }
  return send(404, { status_message: 'not in the stand-in' });
}

module.exports = { answer };

if (require.main === module) {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  if (!port) throw new Error('--port <port>');
  http
    .createServer((req, res) => {
      const { status, body } = answer(req.url);
      console.info(`${req.method} ${req.url.split('?')[0]} ${status}`);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
      res.end(req.method === 'OPTIONS' ? '' : JSON.stringify(body));
    })
    .listen(port, '127.0.0.1', () => console.info(`fake TMDB on http://127.0.0.1:${port}/3`));
}
