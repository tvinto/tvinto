import { Router } from 'express';
import {
  accountSalt,
  addProvider,
  changePassword,
  listProviders,
  login,
  me,
  providerCredentials,
  register,
  removeProvider,
  setKeys
} from '../controllers/accounts.controller';
import { requireAccount } from '../middleware/requireSession';

const router = Router();

// Getting in. These are the only account routes without a session, and they
// are the ones a rate limiter should be strictest about.
router.post('/register', register);
router.post('/login', login);
// Open because signing in cannot begin without it. It answers for names with
// no account as readily as for names with one, which is what keeps it from
// being a directory.
router.get('/salt', accountSalt);

// Everything below needs a signed-in account -- but deliberately not a working
// subscription, since these are the routes that set one up.
router.use(requireAccount);

router.get('/me', me);
router.post('/password', changePassword);
router.post('/keys', setKeys);

router.get('/providers', listProviders);
router.post('/providers', addProvider);
// Before '/providers/:id' would matter if that were a GET; kept above it anyway
// so a later route added there cannot quietly swallow this one.
router.get('/providers/active/credentials', providerCredentials);
router.delete('/providers/:id', removeProvider);

export default router;
