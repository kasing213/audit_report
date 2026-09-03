/**
 * Guards the one file the Payment login command is allowed to create.
 *
 * A Telegram StringSession is a full account credential. The existing login
 * script writes wherever STRING_SESSION_PATH points, which is fine when a human
 * sets it deliberately, and catastrophic if a Payment login run silently
 * overwrites the Company session — that would take the Company worker offline
 * and hand its outreach to the wrong account.
 *
 * So the payment command does not read STRING_SESSION_PATH as an override at
 * all. It accepts exactly one filename, in exactly one directory, and refuses
 * everything else: the Company and Personal sessions, any traversal, and any
 * path that resolves outside the worker directory (which also rules out a
 * symlinked parent).
 */
import * as fs from 'fs';
import * as path from 'path';

export const PAYMENT_SESSION_FILENAME = 'telegram-string-session-payment-tracker.txt';

/**
 * Resolve and validate the payment session path. Pure path validation — the
 * refusal to overwrite is enforced separately by opening with 'wx', which is
 * atomic and so has no check-then-write race.
 */
export function resolvePaymentSessionTarget(cwd: string, configuredPath: string): string {
  if (typeof configuredPath !== 'string' || configuredPath.length === 0) {
    throw new Error('payment session path is required');
  }

  const expected = path.join(cwd, PAYMENT_SESSION_FILENAME);
  const resolved = path.resolve(cwd, configuredPath);

  if (path.basename(resolved) !== PAYMENT_SESSION_FILENAME) {
    throw new Error(
      `refusing to write session file "${path.basename(resolved)}" — only ${PAYMENT_SESSION_FILENAME} is permitted`
    );
  }
  if (path.dirname(resolved) !== path.resolve(cwd)) {
    throw new Error('refusing to write the payment session outside the worker directory');
  }
  if (resolved !== expected) {
    throw new Error(`refusing unexpected payment session path: ${resolved}`);
  }

  // A symlinked worker directory would let the resolved path land elsewhere on
  // disk despite passing the string checks above.
  const realCwd = fs.realpathSync(cwd);
  if (path.resolve(realCwd) !== path.resolve(cwd)) {
    throw new Error('refusing to write the payment session through a symlinked directory');
  }

  return expected;
}

/**
 * Create the session file exclusively. 'wx' fails if the file already exists,
 * so an existing session is never clobbered, and mode 0600 keeps the credential
 * readable only by its owner. The empty file is removed if the write fails, so
 * a failed login does not leave a zero-byte file that blocks the next attempt.
 */
export function writeSessionExclusive(target: string, session: string): void {
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, session, { encoding: 'utf8' });
  } catch (err) {
    fs.closeSync(fd);
    try { fs.unlinkSync(target); } catch { /* nothing to clean up */ }
    throw err;
  }
  fs.closeSync(fd);
}
