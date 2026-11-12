/**
 * TMDB's genres in Croatian, by id. TMDB has no Croatian names for them, so
 * Browse by (TV-32) would otherwise read in English in a Croatian app.
 */
export const HR_GENRE_NAMES: Readonly<Record<number, string>> = {
  28: 'Akcija',
  12: 'Avantura',
  16: 'Animirani',
  35: 'Komedija',
  80: 'Krimi',
  99: 'Dokumentarni',
  18: 'Drama',
  10751: 'Obiteljski',
  14: 'Fantastika',
  36: 'Povijesni',
  27: 'Horor',
  10402: 'Glazbeni',
  9648: 'Misterij',
  10749: 'Romantični',
  878: 'Znanstvena fantastika',
  10770: 'TV film',
  53: 'Triler',
  10752: 'Ratni',
  37: 'Vestern',
  // Shows.
  10759: 'Akcija i avantura',
  10762: 'Dječji',
  10763: 'Vijesti',
  10764: 'Reality',
  10765: 'Znanstvena fantastika i fantastika',
  10766: 'Sapunica',
  10767: 'Talk show',
  10768: 'Rat i politika'
};
