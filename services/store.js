'use strict';

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const NOTE_PATH = path.join(DATA, 'note.json');
const PAYMENTS_PATH = path.join(DATA, 'payments.json');
const AMORT_PATH = path.join(DATA, 'amortization.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function getNote() {
  return readJson(NOTE_PATH);
}

function getPayments() {
  return readJson(PAYMENTS_PATH).payments || [];
}

function getAmortization() {
  return readJson(AMORT_PATH);
}

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Calendar month key in America/Chicago-ish local box time: YYYY-MM */
function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function hasPaidThisMonth(payments, now = new Date()) {
  const key = monthKey(now);
  return payments.some((p) => {
    const d = (p.date || p.postedAt || '').slice(0, 7);
    return d === key && !p.coversArrearsOnly;
  });
}

function findAmortRow(paymentNumber) {
  const amort = getAmortization();
  return (amort.schedule || []).find((r) => r.paymentNumber === paymentNumber);
}

function parseMonth(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return { y, m };
}

function addMonths(ym, n) {
  const { y, m } = parseMonth(ym);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function monthsBetweenInclusive(startYm, endYm) {
  const a = parseMonth(startYm);
  const b = parseMonth(endYm);
  const start = a.y * 12 + (a.m - 1);
  const end = b.y * 12 + (b.m - 1);
  if (end < start) return [];
  const out = [];
  for (let i = start; i <= end; i += 1) {
    const y = Math.floor(i / 12);
    const m = (i % 12) + 1;
    out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
}


function buildPaymentSplit(due, note = getNote()) {
  const billing = note.billing || {};
  const map = billing.qboInvoiceMap || {};
  const onTime = money(
    due.onTimePayment != null
      ? due.onTimePayment
      : billing.onTimePayment != null
        ? billing.onTimePayment
        : due.regularPayment || billing.regularPayment || 0
  );
  const lateFeeAmount = money(due.lateFeeAmount != null ? due.lateFeeAmount : billing.lateFeeAmount || 0);
  const allocations = [];

  for (const ym of due.unpaidMonths || []) {
    const mapped = map[ym] || {};
    const isLate = (due.openLateFeeMonthKeys || []).includes(ym);
    const lateFeeAttach = money(isLate ? lateFeeAmount : 0);
    const baseAmount = money(
      mapped.onTimeAmount != null
        ? mapped.onTimeAmount
        : mapped.baseAmount != null
          ? mapped.baseAmount
          : onTime
    );
    allocations.push({
      month: ym,
      label: mapped.label || ym,
      invoiceDocNumber: mapped.docNumber || null,
      invoiceId: mapped.id || null,
      amount: baseAmount,
      lateFee: lateFeeAttach,
      total: money(baseAmount + lateFeeAttach),
      // Jason 2026-10-02: no invoice creation/drafting from the portal.
      createIfMissing: false,
      txnDate: mapped.txnDate || `${ym}-01`,
      isLate,
    });
  }

  const invoicePortion = money(allocations.reduce((s, a) => s + a.total, 0));

  return {
    allocations,
    invoicePortion,
    accruedLateFees: 0,
    accruedLateFeeMonths: [],
    total: invoicePortion,
  };
}

/**
 * Amount due from calendar billing rules (independent of QBO UI).
 * On-time installment (dueDay): onTimePayment. Flat lateFeeAmount starts on lateFeeDay
 * of that month (on-time + late fee). Historical/informational late-fee tallies are never
 * added to the payable total.
 */
function computeAmountDue(note = getNote(), asOf = new Date()) {
  const billing = note.billing || {};
  const onTime = money(
    billing.onTimePayment != null
      ? billing.onTimePayment
      : billing.regularPayment != null
        ? billing.regularPayment
        : note.state.nextPaymentAmount || 0
  );
  const lateFeeAmount = money(billing.lateFeeAmount != null ? billing.lateFeeAmount : 0);
  const lateAmount = money(onTime + lateFeeAmount);
  const lateFeeDay = Number(billing.lateFeeDay != null ? billing.lateFeeDay : 10);
  const dueDay = Number(billing.dueDay != null ? billing.dueDay : 1);
  const startYm = billing.billingStartMonth || String(note.terms.firstPaymentDate || '').slice(0, 7);
  const paidInstallments = Number(
    billing.paidInstallments != null ? billing.paidInstallments : note.state.lastPaymentNumber || 0
  );

  if (!startYm || !onTime) {
    return {
      total: money(note.state.nextPaymentAmount || 0),
      missedPayments: 0,
      missedAmount: money(note.state.nextPaymentAmount || 0),
      lateFeeMonths: 0,
      lateFees: 0,
      onTimePayment: money(note.state.nextPaymentAmount || 0),
      regularPayment: money(note.state.nextPaymentAmount || 0),
      lateAmount: money(note.state.nextPaymentAmount || 0),
      unpaidMonths: [],
      lateFeeMonthKeys: [],
      asOf: asOf.toISOString(),
    };
  }

  const asOfYm = monthKey(asOf);
  const asOfDay = asOf.getDate();
  // A month is "due" once its due day has arrived (or any later day in/after that month).
  let endYm = asOfYm;
  if (asOfDay < dueDay) {
    endYm = addMonths(asOfYm, -1);
  }

  const allDueMonths = monthsBetweenInclusive(startYm, endYm);
  const unpaidMonths = allDueMonths.slice(paidInstallments);
  const missedPayments = unpaidMonths.length;

  // Late fee applies starting lateFeeDay of that unpaid month.
  const openLateFeeMonthKeys = unpaidMonths.filter((ym) => {
    const { y, m } = parseMonth(ym);
    const threshold = new Date(y, m - 1, lateFeeDay, 0, 0, 0, 0);
    return asOf.getTime() >= threshold.getTime();
  });

  // Informational only — never part of the payable total (Jason 2026-10-02).
  const accruedLateFeeMonths = [];
  const accruedLateFees = 0;

  const openLateFees = money(openLateFeeMonthKeys.length * lateFeeAmount);
  const lateFees = openLateFees;
  const lateFeeMonthKeys = openLateFeeMonthKeys.slice().sort();
  const lateFeeMonths = lateFeeMonthKeys.length;

  // Per-month due: on-time before the 10th, on-time + late fee from the 10th.
  const missedAmount = money(
    unpaidMonths.reduce((sum, ym) => {
      return sum + (openLateFeeMonthKeys.includes(ym) ? lateAmount : onTime);
    }, 0)
  );
  const total = missedAmount;

  const base = {
    total,
    missedPayments,
    missedAmount,
    lateFeeMonths,
    lateFees,
    lateFeeAmount,
    accruedLateFees,
    accruedLateFeeMonths,
    openLateFees,
    openLateFeeMonthKeys,
    onTimePayment: onTime,
    regularPayment: onTime,
    lateAmount,
    unpaidMonths,
    lateFeeMonthKeys,
    paidInstallments,
    monthsDue: allDueMonths.length,
    asOf: asOf.toISOString(),
    asOfMonth: asOfYm,
  };
  base.paymentSplit = buildPaymentSplit(base, note);
  return base;
}

/**
 * Apply a successful payment against the next scheduled installment(s) / arrears.
 * Returns { payment, note, alreadyPaid }.
 */
function applyPayment({ confirmationId, method, cardBrand, cardLast4, amount }) {
  const note = getNote();
  const payments = getPayments();
  const due = computeAmountDue(note);

  if (due.missedPayments === 0) {
    if (hasPaidThisMonth(payments)) {
      return { alreadyPaid: true, note, payments };
    }
  }

  const nextNum = note.state.nextPaymentNumber;
  const row = findAmortRow(nextNum);
  if (!row && due.missedPayments === 0) {
    throw new Error('No remaining scheduled payments on this note.');
  }

  const catchUp = Math.max(1, due.missedPayments || 1);
  let principal = 0;
  let interest = 0;
  let lastRow = row;
  for (let i = 0; i < catchUp; i += 1) {
    const r = findAmortRow(nextNum + i);
    if (!r) break;
    principal = money(principal + r.principal);
    interest = money(interest + r.interest);
    lastRow = r;
  }

  const payAmt = money(amount != null ? amount : due.total || (row && row.payment));

  const split = due.paymentSplit || buildPaymentSplit(due, note);
  const payment = {
    paymentNumber: nextNum,
    paymentNumbersCovered: catchUp,
    date: new Date().toISOString().slice(0, 10),
    dueDate: row ? row.dueDate : due.unpaidMonths[0] || null,
    amount: payAmt,
    principal,
    interest,
    lateFees: due.lateFees,
    missedPayments: due.missedPayments,
    qboAllocation: split,
    confirmationId,
    method: method || `${cardBrand || 'Card'} ****${cardLast4 || '0000'}`,
    cardBrand: cardBrand || null,
    cardLast4: cardLast4 || null,
    postedAt: new Date().toISOString(),
    qboStatus: 'pending',
    qboMessage: null,
    qboTxnId: null,
  };

  payments.push(payment);
  writeJson(PAYMENTS_PATH, { payments });

  if (note.billing) {
    note.billing.paidInstallments = Number(note.billing.paidInstallments || 0) + catchUp;
  }

  const newBalance = lastRow ? money(lastRow.balance) : note.state.currentPrincipalBalance;
  const year = new Date().getFullYear();
  let ytd = note.state.ytdInterestPaid || 0;
  if (note.state.ytdYear !== year) {
    ytd = 0;
    note.state.ytdYear = year;
  }
  ytd = money(ytd + interest);

  const following = findAmortRow((nextNum || 0) + catchUp);

  note.state.currentPrincipalBalance = newBalance;
  note.state.lastPaymentNumber = (nextNum || 0) + catchUp - 1;
  note.state.ytdInterestPaid = ytd;
  note.state.ytdYear = year;

  if (following) {
    note.state.nextPaymentNumber = following.paymentNumber;
    note.state.nextPaymentDueDate = following.dueDate;
    note.state.nextPaymentAmount = following.payment;
    note.state.nextPrincipal = following.principal;
    note.state.nextInterest = following.interest;
  } else {
    note.state.nextPaymentNumber = null;
    note.state.nextPaymentDueDate = null;
    note.state.nextPaymentAmount = 0;
    note.state.nextPrincipal = 0;
    note.state.nextInterest = 0;
  }

  writeJson(NOTE_PATH, note);

  return { alreadyPaid: false, payment, note, payments, amountDue: computeAmountDue(note) };
}

function updatePaymentQbo(confirmationId, { qboStatus, qboMessage, qboTxnId }) {
  const store = readJson(PAYMENTS_PATH);
  const p = (store.payments || []).find((x) => x.confirmationId === confirmationId);
  if (!p) return null;
  p.qboStatus = qboStatus;
  p.qboMessage = qboMessage || null;
  p.qboTxnId = qboTxnId || null;
  writeJson(PAYMENTS_PATH, store);
  return p;
}

function getPaymentByConfirmation(confirmationId) {
  return getPayments().find((p) => p.confirmationId === confirmationId) || null;
}

function recentPayments(limit = 12) {
  const payments = getPayments()
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return payments.slice(0, limit);
}

module.exports = {
  getNote,
  getPayments,
  getAmortization,
  applyPayment,
  updatePaymentQbo,
  getPaymentByConfirmation,
  recentPayments,
  hasPaidThisMonth,
  monthKey,
  money,
  computeAmountDue,
  buildPaymentSplit,
};
