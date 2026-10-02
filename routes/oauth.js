'use strict';

/**
 * Intuit OAuth 2.0 for TWB QuickBooks Online (background only).
 * No borrower-facing QuickBooks settings page or nav.
 * Tokens may be seeded via .env / data/qbo-tokens.json; callback still accepted
 * if an authorize flow was started out-of-band. Pay posts JEs via services/qbo.js.
 */

const express = require('express');
const qbo = require('../services/qbo');

function createOAuthRouter({ requireAuth }) {
  const router = express.Router();

  function notForBorrowers(_req, res) {
    res.status(404).render('error', {
      title: 'Not found',
      message: 'That page is not available in the borrower portal.',
    });
  }

  // Former UI routes — hidden from borrowers
  router.get('/settings/qbo', requireAuth, notForBorrowers);
  router.get('/oauth/connect', requireAuth, notForBorrowers);
  router.post('/oauth/disconnect', requireAuth, notForBorrowers);

  /** Intuit redirect URI — keep for token exchange when authorize is started externally */
  router.get('/oauth/callback', async (req, res) => {
    const { code, state, realmId, error, error_description: errorDescription } = req.query;

    if (error) {
      console.error('Intuit OAuth error:', error, errorDescription || '');
      return res.redirect('/dashboard');
    }

    if (!req.session.user) {
      return res.redirect('/login?next=' + encodeURIComponent('/dashboard'));
    }

    if (!state || !req.session.qboOAuthState || state !== req.session.qboOAuthState) {
      console.error('OAuth state mismatch on callback');
      delete req.session.qboOAuthState;
      return res.redirect('/dashboard');
    }
    delete req.session.qboOAuthState;

    if (!code || !realmId) {
      console.error('Missing code or realmId from Intuit callback');
      return res.redirect('/dashboard');
    }

    try {
      const tokens = await qbo.exchangeAuthorizationCode(String(code), String(realmId));
      console.log('QBO connected, realm', tokens.realmId);
      return res.redirect('/dashboard');
    } catch (err) {
      console.error('QBO token exchange failed:', err.message);
      return res.redirect('/dashboard');
    }
  });

  return router;
}

module.exports = { createOAuthRouter };
