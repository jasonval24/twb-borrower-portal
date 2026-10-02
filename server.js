'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const store = require('./services/store');
const qbo = require('./services/qbo');
const { createOAuthRouter } = require('./routes/oauth');

const app = express();
const PORT = Number(process.env.PORT) || 3847;

const DEMO_PASSWORD = process.env.DEMO_BORROWER_PASSWORD || 'ABC12345';

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function borrowerPhone() {
  const note = store.getNote();
  const fromNote = digitsOnly(note.borrower && note.borrower.phone);
  const fromEnv = digitsOnly(process.env.DEMO_BORROWER_PHONE);
  return fromNote || fromEnv;
}

function buildPaypalMeUrl(amount) {
  const raw = String(process.env.PAYPAL_ME_URL || process.env.PAYPAL_ME_USERNAME || '').trim();
  if (!raw) return null;
  let base;
  if (/^https?:\/\//i.test(raw)) {
    base = raw.replace(/\/$/, '');
  } else {
    const user = raw.replace(/^@/, '').replace(/^paypal\.me\//i, '');
    base = 'https://www.paypal.me/' + encodeURIComponent(user);
  }
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return base;
  return base + '/' + n.toFixed(2);
}


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    name: 'twb.sid',
    secret: process.env.SESSION_SECRET || 'twb-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

app.use((req, res, next) => {
  res.locals.demo = true;
  res.locals.user = req.session.user || null;
  res.locals.qboReady = qbo.isConfigured();
  res.locals.fmtMoney = (n) =>
    Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  res.locals.fmtDate = (iso) => {
    if (!iso) return '—';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${m}/${d}/${y}`;
  };
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

app.use(createOAuthRouter({ requireAuth }));

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  const note = store.getNote();
  res.render('login', {
    title: 'Sign in',
    error: null,
    phone: note.borrower.phone || '',
  });
});

app.post('/login', (req, res) => {
  const phoneRaw = String(req.body.phone || '').trim();
  const phone = digitsOnly(phoneRaw);
  const password = String(req.body.password || '');
  const expectedPhone = borrowerPhone();
  const note = store.getNote();

  if (!expectedPhone) {
    return res.status(503).render('login', {
      title: 'Sign in',
      error: 'Borrower cell phone is not set yet. Contact Texas Wealth Builders.',
      phone: phoneRaw,
    });
  }

  if (phone === expectedPhone && password === DEMO_PASSWORD) {
    req.session.user = {
      phone: expectedPhone,
      email: note.borrower.email || null,
      name: note.borrower.name,
    };
    const next = String(req.query.next || req.body.next || '/dashboard');
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
    return res.redirect(safeNext);
  }
  res.status(401).render('login', {
    title: 'Sign in',
    error: 'Invalid cell phone or password.',
    phone: phoneRaw,
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('twb.sid');
    res.redirect('/login');
  });
});

app.get('/dashboard', requireAuth, (req, res) => {
  const note = store.getNote();
  const payments = store.recentPayments(12);
  const paidThisMonth = store.hasPaidThisMonth(store.getPayments());
  const amountDue = store.computeAmountDue(note);
  res.render('dashboard', {
    title: 'Dashboard',
    note,
    payments,
    paidThisMonth,
    amountDue,
    monthKey: store.monthKey(),
  });
});

/** Amortization is independent of QBO — local schedule only. */
app.get('/amortization', requireAuth, (req, res) => {
  const note = store.getNote();
  const amort = store.getAmortization();
  res.render('amortization', {
    title: 'Amortization schedule',
    note,
    amort,
  });
});

app.get('/pay', requireAuth, (req, res) => {
  const note = store.getNote();
  const amountDue = store.computeAmountDue(note);
  const paidThisMonth = store.hasPaidThisMonth(store.getPayments());
  res.render('pay', {
    title: 'Make a payment',
    note,
    amountDue,
    payments: store.recentPayments(12),
    paidThisMonth,
    monthKey: store.monthKey(),
    error: null,
    qboStatus: qbo.connectionStatus(),
    paypalMeUrl: buildPaypalMeUrl(amountDue.total),
  });
});

app.post('/pay', requireAuth, async (req, res) => {
  const note = store.getNote();
  const amountDue = store.computeAmountDue(note);
  const paidThisMonth = store.hasPaidThisMonth(store.getPayments());

  if (amountDue.total <= 0) {
    return res.status(400).render('pay', {
      title: 'Make a payment',
      note,
      amountDue,
      paidThisMonth,
      monthKey: store.monthKey(),
      error: 'Nothing is due right now.',
      payments: store.recentPayments(12),
      qboStatus: qbo.connectionStatus(),
    });
  }

  if (!note.state.nextPaymentNumber && amountDue.missedPayments === 0) {
    return res.status(400).render('pay', {
      title: 'Make a payment',
      note,
      amountDue,
      paidThisMonth: false,
      monthKey: store.monthKey(),
      error: 'This note has no remaining scheduled payments.',
      payments: store.recentPayments(12),
      qboStatus: qbo.connectionStatus(),
      paypalMeUrl: buildPaypalMeUrl(amountDue.total),
    });
  }

  const cardBrand = String(req.body.cardBrand || 'Visa').trim() || 'Visa';
  const cardLast4 = String(req.body.cardLast4 || '').replace(/\D/g, '').slice(-4);
  const cardName = String(req.body.cardName || '').trim();
  const cardExp = String(req.body.cardExp || '').trim();

  if (!cardLast4 || cardLast4.length !== 4 || !cardName || !cardExp) {
    return res.status(400).render('pay', {
      title: 'Make a payment',
      note,
      amountDue,
      paidThisMonth: false,
      monthKey: store.monthKey(),
      error: 'Enter cardholder name, expiration, and last 4 digits (demo tokenization).',
      payments: store.recentPayments(12),
      qboStatus: qbo.connectionStatus(),
    });
  }

  const confirmationId = `DEMO-${Date.now().toString(36).toUpperCase()}-${Math.floor(
    Math.random() * 900 + 100
  )}`;

  let result;
  try {
    result = store.applyPayment({
      confirmationId,
      cardBrand,
      cardLast4,
      method: `${cardBrand} ****${cardLast4}`,
      amount: amountDue.total,
    });
  } catch (err) {
    const n = store.getNote();
    return res.status(500).render('pay', {
      title: 'Make a payment',
      note: n,
      amountDue: store.computeAmountDue(n),
      paidThisMonth: store.hasPaidThisMonth(store.getPayments()),
      monthKey: store.monthKey(),
      error: err.message,
      payments: store.recentPayments(12),
      qboStatus: qbo.connectionStatus(),
      paypalMeUrl: buildPaypalMeUrl(amountDue.total),
    });
  }

  if (result.alreadyPaid) {
    return res.redirect('/pay');
  }

  // Post P/I-coded Journal Entry to QBO when configured; otherwise Pending QuickBooks sync
  const qboResult = await qbo.postPayment(result.payment, result.note);
  store.updatePaymentQbo(confirmationId, {
    qboStatus: qboResult.status,
    qboMessage: qboResult.message,
    qboTxnId: qboResult.txnId || null,
  });

  return res.redirect(`/receipt/${encodeURIComponent(confirmationId)}`);
});

app.get('/receipt/:id', requireAuth, (req, res) => {
  const payment = store.getPaymentByConfirmation(req.params.id);
  if (!payment) {
    return res.status(404).render('error', {
      title: 'Receipt not found',
      message: 'No payment found for that confirmation id.',
    });
  }
  const note = store.getNote();
  res.render('receipt', {
    title: 'Payment receipt',
    note,
    payment,
  });
});

app.get('/health', (_req, res) => {
  const status = qbo.connectionStatus();
  res.json({
    ok: true,
    service: 'twb-borrower-portal',
    noteId: store.getNote().noteId,
    qboConfigured: status.readyToPost,
    qbo: {
      environment: status.environment,
      oauthAppReady: status.oauthAppReady,
      tokensPresent: status.tokensPresent,
      accountsMapped: status.accountsMapped,
      missing: status.missing,
    },
  });
});

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not found',
    message: 'That page does not exist.',
  });
});

app.listen(PORT, () => {
  console.log(`TWB Borrower Portal listening on http://localhost:${PORT}`);
  console.log(`Demo login: cell ${borrowerPhone() || '(unset)'} / ${DEMO_PASSWORD}`);
  const status = qbo.connectionStatus();
  if (!status.readyToPost) {
    console.log(
      `QBO: not ready — payments will show "Pending QuickBooks sync" (missing: ${
        status.missing.join(', ') || 'none'
      })`
    );
    console.log(`QBO: configure via .env / data/qbo-tokens.json (no borrower UI)`);
  } else {
    console.log('QBO: ready — Pay will post Journal Entry with P/I split');
  }
});
