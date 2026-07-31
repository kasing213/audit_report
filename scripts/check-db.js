/**
 * Redirects every check script to a scratch database on the same cluster, so
 * verification never writes to production `Audit`. Must be required and invoked
 * as the FIRST statement of a check script, before any other module reads
 * DATABASE_URL — DatabaseConnection caches it on first use.
 */
require('dotenv').config();

const SCRATCH_DB = 'Audit_check';

function useScratchDb() {
  if (process.env.CHECK_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CHECK_DATABASE_URL;
    return process.env.DATABASE_URL;
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL not set');
  const url = new URL(raw);
  url.pathname = `/${SCRATCH_DB}`;
  process.env.DATABASE_URL = url.toString();
  return process.env.DATABASE_URL;
}

module.exports = { useScratchDb, SCRATCH_DB };
