import { Router } from 'express';
import {
  getCategories,
  getStreams,
  searchStreams,
  getStreamInfo,
  getSeriesInfo,
  getEPG,
  getEPGShort,
  getAllEPG,
  getExternalEPG,
  getNowEPG,
  refreshEPGForStreams,
  pruneEPG,
  getNowEPGForStreams,
  getEPGFromDbForStreams,
  createPlaybackTicket,
  playStream,
  getManualOrder,
  saveManualOrder,
  getFavorites,
  getFavoriteIds,
  addFavorite,
  removeFavorite
} from '../controllers/streams.controller';
import {
  getRecent,
  lookupProgress,
  getSeriesProgress,
  saveProgress,
  deleteProgress
} from '../controllers/progress.controller';
import { requireSession } from '../middleware/requireSession';

const router = Router();

// Redeems its own short-lived ticket, so it must stay outside requireSession:
// a media element cannot send an Authorization header.
router.get('/play/:ticket', playStream);

// Everything below acts on the caller's Xtream account.
router.use(requireSession);

// Fetches a caller-supplied URL rather than provider data. Behind the session
// all the same: open, it let anybody on the internet make this server fetch
// any address, its own network's included.
router.post('/epg/external', getExternalEPG);

// Playback
router.post('/play/ticket', createPlaybackTicket);

// Favourites and manual ordering (before the catch-all)
router.get('/favorites', getFavorites);
router.get('/favorites/ids', getFavoriteIds);
router.post('/favorites', addFavorite);
router.delete('/favorites', removeFavorite);

router.get('/order', getManualOrder);
router.post('/order', saveManualOrder);

// Watch history and resume points. These sit above the catch-all below, which
// would otherwise read /progress/recent as the category "recent" of type
// "progress".
router.get('/progress/recent', getRecent);
router.get('/progress/series/:seriesId', getSeriesProgress);
router.post('/progress/lookup', lookupProgress);
router.post('/progress', saveProgress);
router.delete('/progress', deleteProgress);

// Categories and streams
router.get('/categories/:type', getCategories);
router.post('/search', searchStreams);

// Stream info
router.get('/info', getStreamInfo);

// Series info (use distinct path to avoid conflict with catch-all below)
router.get('/series/info/:series_id', getSeriesInfo);

// EPG routes (must come before catch-all route)
router.get('/epg/:stream_id', getEPG);
router.get('/epg-short/:stream_id', getEPGShort);
router.get('/epg-all', getAllEPG);
router.get('/epg-now', getNowEPG);
router.post('/epg/refresh', refreshEPGForStreams);
router.delete('/epg/prune', pruneEPG);
router.post('/epg-now/streams', getNowEPGForStreams);
router.post('/epg/db', getEPGFromDbForStreams);

// Catch-all route for streams (must come last)
router.get('/:type/:categoryId', getStreams);

export default router;
