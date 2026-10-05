'use strict';

// How many days before expiry a licence starts raising warnings, by how
// often it renews. One place for these numbers so the Licences page, the
// dashboard widget, the TV dashboard and the daily notification digest can't
// disagree.
const WARNING_DAYS = { monthly: 5, yearly: 35 };

// Licences with no renewal period set yet keep the window every licence had
// before the period existed.
const FALLBACK_WARNING_DAYS = 30;

const PERIODS = Object.keys(WARNING_DAYS);

/** 'monthly' | 'yearly' | null — anything else (incl. '') means "not set". */
function normalizePeriod(p) {
  return PERIODS.includes(p) ? p : null;
}

function warningDays(period) {
  return WARNING_DAYS[period] ?? FALLBACK_WARNING_DAYS;
}

// Same day arithmetic the app has always used (date-only value parsed as UTC
// midnight, rounded up), so "0 days left" still means "expires today".
function daysUntil(dateStr) {
  return Math.ceil((new Date(dateStr) - new Date()) / 86400000);
}

/** { days, warn_days, status } where status is 'expired' | 'expiring' | 'ok',
 * or all null when there's no expiry date. */
function expiryState(expiryDate, period) {
  if (!expiryDate) return { days: null, warn_days: warningDays(period), status: null };
  const days = daysUntil(expiryDate);
  const warn = warningDays(period);
  return { days, warn_days: warn, status: days < 0 ? 'expired' : days <= warn ? 'expiring' : 'ok' };
}

module.exports = { WARNING_DAYS, FALLBACK_WARNING_DAYS, normalizePeriod, warningDays, daysUntil, expiryState };
