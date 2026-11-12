/**
 * A believable line-up for `fake-xtream.js --demo`: the README's screenshots
 * and anything else that is shown to people rather than tested.
 *
 * Every channel, programme, film and show here is invented -- no real
 * broadcaster, title or person, so nothing in a screenshot is anybody's name
 * or trademark. The pictures are drawn here too, as SVG, so the demo needs
 * nothing from the internet.
 */

const added = String(Math.floor(Date.now() / 1000) - 3 * 86400);

/** A colour pair from a name, so each poster and logo keeps its own. */
const PALETTES = [
  ['#1d3557', '#e63946'], ['#2a9d8f', '#264653'], ['#6d597a', '#e56b6f'], ['#003049', '#f77f00'],
  ['#3a0ca3', '#4cc9f0'], ['#283618', '#dda15e'], ['#22223b', '#9a8c98'], ['#5f0f40', '#fb8b24'],
  ['#0b132b', '#5bc0be'], ['#432818', '#bb9457'], ['#14213d', '#fca311'], ['#2b2d42', '#ef233c']
];
const hash = text => [...text].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7);
const palette = text => PALETTES[hash(text) % PALETTES.length];
const esc = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** Words onto lines of about `width` characters. */
const lines = (text, width) => {
  const out = [];
  for (const word of text.split(' ')) {
    const last = out[out.length - 1];
    if (last && (last + ' ' + word).length <= width) {
      out[out.length - 1] = `${last} ${word}`;
    } else {
      out.push(word);
    }
  }
  return out;
};

const poster = (title, year) => {
  const [a, b] = palette(title);
  const rows = lines(title.toUpperCase(), 11).slice(0, 4);
  const text = rows
    .map((row, i) => `<text x="36" y="${500 - (rows.length - 1 - i) * 50}" font-size="42" font-weight="800" letter-spacing="2">${esc(row)}</text>`)
    .join('');
  const h = hash(title);
  // Three compositions, so a row of posters is not one picture recoloured.
  const shapes = [
    `<circle cx="${120 + (h % 200)}" cy="210" r="150" fill="#fff" opacity=".10"/><circle cx="${80 + (h % 240)}" cy="270" r="90" fill="#000" opacity=".14"/>`,
    `<circle cx="${100 + (h % 200)}" cy="250" r="70" fill="#fff" opacity=".55"/><rect y="270" width="400" height="330" fill="#000" opacity=".35"/><rect y="300" width="400" height="6" fill="#fff" opacity=".12"/>`,
    `<g opacity=".12" fill="#fff">${[0, 1, 2, 3, 4].map(n => `<rect x="${-200 + n * 120}" y="-100" width="40" height="900" transform="rotate(25 200 300)"/>`).join('')}</g><rect x="36" y="${300 - (h % 80)}" width="120" height="8" fill="#fff" opacity=".7"/>`
  ][h % 3];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></linearGradient></defs>
<rect width="400" height="600" fill="url(#g)"/>${shapes}<rect width="400" height="600" fill="url(#s)"/>
<g font-family="Segoe UI, Arial, sans-serif" fill="#fff"><text x="36" y="64" font-size="22" letter-spacing="6" opacity=".85">${esc(year)}</text>${text}</g>
</svg>`;
};

/** A landscape at dusk: sky, a low sun, and three ridges, each darker than the last. */
const backdrop = title => {
  const [a, b] = palette(title);
  const h = hash(title);
  const ridge = (base, rough, seed) => {
    const points = [];
    for (let x = 0; x <= 1280; x += 80) {
      points.push(`${x},${base - (((seed * (x + 37)) >>> 3) % rough)}`);
    }
    return `M0,720 L${points.join(' L')} L1280,720 Z`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="1280" height="720" fill="url(#sky)"/>
<circle cx="${760 + (h % 300)}" cy="${330 + (h % 60)}" r="90" fill="#fff" opacity=".35"/>
<path d="${ridge(470, 120, h % 97 + 13)}" fill="#000" opacity=".25"/>
<path d="${ridge(540, 90, h % 89 + 7)}" fill="#000" opacity=".35"/>
<path d="${ridge(620, 60, h % 83 + 5)}" fill="#000" opacity=".5"/>
</svg>`;
};

const logo = name => {
  const [a, b] = palette(name);
  const words = name.split(' ').filter(word => /^[A-Z0-9]/.test(word));
  const initials = words.length === 1 ? words[0].slice(0, 2) : words.map(word => word[0]).join('').slice(0, 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
<rect width="200" height="200" rx="36" fill="${a}"/><rect x="0" y="120" width="200" height="80" fill="${b}" opacity=".35"/>
<text x="100" y="122" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${initials.length > 2 ? 64 : 80}" font-weight="800" fill="#fff">${esc(initials)}</text>
</svg>`;
};

/** Channels by category, with what each shows. */
const LINE_UP = [
  ['News', [
    ['Northline News', ['Morning Briefing', 'World Desk', 'Market Watch', 'The Interview', 'Evening Edition', 'Weather and Roads']],
    ['Meridian 24', ['Headlines', 'Business Hour', 'Global Report', 'Science Now', 'Late Bulletin']],
    ['Harbour Report', ['Coast to Coast', 'Local Matters', 'The Debate', 'City Hall Live']],
    ['Daybreak World', ['First Edition', 'Around the World', 'The Big Picture', 'Night Desk']],
    ['Capital Wire', ['Parliament Live', 'Politics Today', 'The Week Ahead', 'Briefing Room']],
    ['Eastern Standard', ['News at Noon', 'Regional Round-up', 'Farming Today', 'Late Edition']],
    ['Pressroom', ['Media Watch', 'The Papers', 'On the Record', 'Fact Check']]
  ]],
  ['Sport', [
    ['Stadium One', ['Matchday Live', 'Goals of the Week', 'Pre-Match Show', 'The Final Whistle', 'Classic Matches']],
    ['Stadium Two', ['Basketball Tonight', 'Courtside', 'Tennis: Quarter-Final', 'Season Review']],
    ['Velocity Motorsport', ['Qualifying', 'Grand Prix Live', 'Pit Lane', 'Rally Highlights']],
    ['Fieldside', ['Cycling: Mountain Stage', 'Athletics Gala', 'The Locker Room']],
    ['Court Vision', ['Volleyball: Semi-Final', 'Handball Live', 'Courtside Classics']],
    ['Fairway', ['Golf: Final Round', 'Swing Clinic', 'The Back Nine']],
    ['Winter Sports Live', ['Ski Jumping', 'Biathlon: Sprint', 'Downhill Highlights']],
    ['Ringside', ['Fight Night', 'Weigh-In', 'Boxing Classics']]
  ]],
  ['Films', [
    ['Reel Classics', ['The Quiet Season', 'Seven Bridges', 'Copper Sky']],
    ['Midnight Cinema', ['Undertow', 'Hollow Pines', 'Static']],
    ['Silver Screen Plus', ['A Week in Lisbon', 'The Long Weekend', 'Afterglow']]
  ]],
  ['Documentaries', [
    ['Wild Atlas', ['Rivers of Ice', 'The Night Forest', 'Islands', 'Migration']],
    ['Deep Blue', ['Reef Life', 'The Abyss', 'Ocean Giants', 'Tides']],
    ['Timeline History', ['Empires of Salt', 'The Railway Age', 'Lost Cities', 'Inventors']]
  ]],
  ['Kids', [
    ['Little Lantern', ['Paper Boats', 'Counting Clouds', 'The Busy Burrow', 'Story Time']],
    ['Puddle Jump', ['Rocket Pals', 'Garden Gang', 'Dino Days', 'Bedtime Tales']]
  ]],
  ['Music', [
    ['Velvet Hits', ['Top Twenty', 'Unplugged', 'Throwback Hour', 'New This Week']],
    ['Static Live', ['Festival Sets', 'Studio Sessions', 'Late Night Mix']]
  ]],
  ['Lifestyle', [
    ['Kitchen Table', ['Weeknight Suppers', 'Bake Off at Home', 'Market to Plate', 'One Pot']],
    ['Open Road', ['Slow Travel', 'Mountain Towns', 'Coastlines', 'Rail Journeys']]
  ]]
];

/** What a programme is about, by the kind of channel it is on. */
const ABOUT = [
  ['The main stories of the day, with reports from the regions and the weather.', 'Business and markets, and what they mean for everyone else.', 'A long conversation with one guest about one subject.'],
  ['Live coverage with commentary and analysis from the studio.', 'Every goal, every save and every talking point.', 'The week in sport, looked back on.'],
  ['A feature film, uncut.', 'A late-night favourite.', 'A modern classic.'],
  ['A year in the life of the creatures that live there.', 'Filmed over three seasons, from the surface to the deep.', 'How the past shaped the places we live in now.'],
  ['Songs, stories and a lot of mess.', 'Short adventures for small people.', 'Gentle tales before bed.'],
  ['The songs everyone is playing this week.', 'Live sets from this summer’s festivals.', 'Stripped back and recorded in one take.'],
  ['Simple food for busy evenings.', 'Slow journeys through places worth the detour.', 'From the market to the table in under an hour.']
];

const liveCategories = LINE_UP.map(([name], i) => ({ category_id: String(i + 1), category_name: name, parent_id: 0 }));
const live = [];
const shows = {};
LINE_UP.forEach(([, channels], c) =>
  channels.forEach(([name, programmes]) => {
    const id = `demo${live.length + 1}`;
    shows[id] = programmes;
    live.push({
      num: live.length + 1, name, stream_type: 'live', stream_id: 1000 + live.length, stream_icon: `ART/logo/${live.length + 1}.svg`,
      epg_channel_id: id, added, category_id: String(c + 1), tv_archive: c === 0 ? 1 : 0, tv_archive_duration: c === 0 ? 3 : 0
    });
  })
);

const DESCRIPTIONS = [
  'A lighthouse keeper on a remote island finds a message that changes how she sees the mainland and the people she left there.',
  'Two estranged brothers drive across the country to scatter their father’s ashes, and argue about everything on the way.',
  'When the harbour freezes for the first time in a century, a small town has one winter to decide what it wants to become.',
  'A young cartographer is hired to map a valley that does not appear on any chart, and learns why.',
  'An engineer on a failing space station has nine days to bring her crew home.',
  'A chef who has lost her sense of taste opens one last restaurant.',
  'A detective returns to the town she grew up in to close the case her mother never could.',
  'Three friends, one rented house, and the longest weekend of their lives.'
];

const vodCategories = ['Drama', 'Thriller', 'Comedy', 'Science fiction', 'Family', 'EN| 4K UHD', 'HR| Filmovi', 'DE| Filme'].map((name, i) => ({
  category_id: String(11 + i), category_name: name, parent_id: 0
}));

/**
 * The same films again, the way providers list them: one copy per language
 * and quality, each in its own category with the provider's tags in the name.
 * The app groups them into one film with its copies side by side.
 */
const COPIES = [
  [0, 'EN| The Last Lighthouse (2024) [4K]', 16], [0, 'HR| The Last Lighthouse (2024)', 17], [0, 'DE| The Last Lighthouse (2024) HD', 18],
  [1, 'EN| Glass Harbour (2023) 4K UHD', 16], [1, 'HR| Glass Harbour (2023) [MULTI SUB]', 17],
  [15, 'EN| Northbound (2024) [4K HDR]', 16], [15, 'HR| Northbound (2024)', 17], [15, 'DE| Northbound (2024)', 18],
  [5, 'HR| Undertow (2023)', 17], [5, 'DE| Undertow (2023) HD', 18]
];
const FILMS = [
  ['The Last Lighthouse', 2024, 0], ['Glass Harbour', 2023, 0], ['The Quiet Season', 2021, 0], ['Seven Bridges', 2022, 0], ['A Week in Lisbon', 2022, 0],
  ['Undertow', 2023, 1], ['Hollow Pines', 2023, 1], ['Static', 2021, 1], ['Night Train to Varna', 2024, 1], ['The Cartographer’s Daughter', 2025, 1],
  ['The Long Weekend', 2021, 2], ['Second Sunrise', 2024, 2], ['Lantern Street', 2025, 2], ['Copper Sky', 2022, 2],
  ['Orbit of Small Things', 2025, 3], ['Northbound', 2024, 3], ['Iron Tide', 2021, 3], ['Blue Hour', 2025, 3], ['Afterglow', 2025, 3],
  ['Fable of the Fox', 2023, 4], ['Echo Valley', 2024, 4], ['Paper Kingdoms', 2022, 4], ['The Mapmaker', 2020, 4], ['Salt and Iron', 2023, 4],
  ['Winter Orchard', 2024, 0], ['The Borrowed Coat', 2023, 0], ['Small Hours', 2025, 0], ['Riverbend', 2022, 0],
  ['Black Water Road', 2024, 1], ['The Fourth Key', 2022, 1], ['Dead Reckoning', 2025, 1],
  ['Happy Accidents', 2023, 2], ['Wedding Season', 2024, 2], ['The Neighbours', 2025, 2],
  ['Halcyon', 2024, 3], ['Ground Control', 2023, 3]
];
const vod = FILMS.map(([title, year, genre], i) => ({
  num: i + 1, name: `${title} (${year})`, stream_type: 'movie', stream_id: 2000 + i, stream_icon: `ART/poster/film/${i}.svg`,
  rating: (6.4 + ((i * 7) % 25) / 10).toFixed(1), added: String(Number(added) - i * 86400), category_id: String(11 + genre),
  container_extension: 'mkv', plot: DESCRIPTIONS[i % DESCRIPTIONS.length], year: String(year)
}));
COPIES.forEach(([film, name, category], i) => {
  const original = vod[film];
  vod.push({ ...original, num: vod.length + 1, name, stream_id: 2100 + i, category_id: String(category), added: String(Number(added) - (30 + i) * 86400) });
});

const seriesCategories = ['Drama', 'Crime', 'Comedy', 'Kids'].map((name, i) => ({ category_id: String(21 + i), category_name: name, parent_id: 0 }));
const SHOWS = [
  ['Harbour Lights', 2023, 0, 3], ['The Archive', 2024, 0, 2], ['Frontier Station', 2025, 0, 1], ['Parallel Lines', 2022, 0, 2],
  ['Deep Field', 2024, 1, 2], ['Old Town', 2021, 1, 4], ['Signal and Noise', 2023, 1, 1],
  ['Kitchen Brigade', 2022, 2, 3], ['The Long Road', 2025, 2, 1],
  ['Little Detectives', 2023, 3, 2]
];
const series = SHOWS.map(([title, year, genre, seasons], i) => ({
  name: `${title} (${year})`, seasons, episodes: 8, num: i + 1, series_id: 3000 + i, cover: `ART/poster/show/${i}.svg`,
  plot: DESCRIPTIONS[(i + 3) % DESCRIPTIONS.length], cast: '', director: '', genre: seriesCategories[genre].category_name,
  releaseDate: `${year}-03-01`, last_modified: String(Number(added) - i * 43200), rating: (7 + (i % 5) / 2).toFixed(1),
  rating_5based: 4, backdrop_path: [`ART/backdrop/show/${i}.svg`], youtube_trailer: '', episode_run_time: '45',
  category_id: String(21 + genre)
}));

const EPISODE_TITLES = ['Arrival', 'The Map', 'Low Tide', 'Signals', 'The Visitor', 'Fault Lines', 'Homecoming', 'First Light'];
const episodeTitle = (show, season, episode) => `${show.name} - S${season}E${episode} - ${EPISODE_TITLES[(episode - 1) % EPISODE_TITLES.length]}`;
const EPISODE_PLOTS = [
  'Everything starts with a stranger arriving on the last ferry of the year.',
  'An old map turns up where nobody expected it, and two people want it for different reasons.',
  'With the tide out, something long buried comes back into view.',
  'A message on the radio that should not be possible.',
  'A visitor asks too many questions, and gets some answers.',
  'Old loyalties are tested when the truth about the fire comes out.',
  'A return home that nobody planned for.',
  'The season ends where it began, with the light on the water.'
];
const episodePlot = (show, episode) => EPISODE_PLOTS[(episode - 1) % EPISODE_PLOTS.length];

/** The artwork, by the path in an address above. */
const art = path => {
  const film = /^poster\/film\/(\d+)\.svg$/.exec(path);
  if (film && FILMS[film[1]]) return poster(FILMS[film[1]][0], String(FILMS[film[1]][1]));
  const show = /^poster\/show\/(\d+)\.svg$/.exec(path);
  if (show && SHOWS[show[1]]) return poster(SHOWS[show[1]][0], String(SHOWS[show[1]][1]));
  const back = /^backdrop\/(film|show)\/(\d+)\.svg$/.exec(path);
  if (back) return backdrop((back[1] === 'film' ? FILMS : SHOWS)[back[2]]?.[0] ?? path);
  const mark = /^logo\/(\d+)\.svg$/.exec(path);
  if (mark && live[mark[1] - 1]) return logo(live[mark[1] - 1].name);
  return null;
};

/** What a demo channel shows, in turn. */
const programmeOf = (entry, i) => {
  const titles = shows[entry.epg_channel_id];
  return {
    title: titles[i % titles.length],
    minutes: [30, 60, 45, 90, 60, 120][(i + entry.num) % 6],
    desc: ABOUT[entry.category_id - 1][(i + entry.num) % 3]
  };
};

module.exports = { liveCategories, live, vodCategories, vod, seriesCategories, series, episodeTitle, episodePlot, art, programmeOf };
