import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StaffMember, StaffAlias, StaffDirectory, normalizeStaffName, findStaffByName, resolveSender, decideOwner,
} from '../../src/staff/staff-resolver';
import { BulkEntryFlow } from '../../src/bot/flows/bulk-entry-flow';
import { FULL_FORMAT_REPORT } from '../bulk/full-format-fixture';
import { extractOwnerName } from '../../src/parser/bulk-report-parser';

// Mirrors production (30/10/26): Bery's registered name carries a hidden
// character, Theary is a group admin, Bery's second account is unregistered.
const member = (employee_id: string, name: string, telegram_chat_id: string, extra: Partial<StaffMember> = {}): StaffMember => ({
  employee_id, name, telegram_chat_id, status: 'ACTIVE', role: 'SALES', telegram_username: null, is_admin: false, ...extra,
});
const STAFF: StaffMember[] = [
  member('boss', 'Boss 1450060367', '1450060367', { role: 'BOSS', is_admin: true }),
  member('theary', 'Theary Thoeurn', '5757448268', { is_admin: true }),
  member('bery', 'លោកគ្រូ​Bery', '2101995560', { telegram_username: 'sunhiring' }),
  member('sony', 'ឆៃ សុនី', '5011482628', { telegram_username: 'sony1681' }),
  member('ka', 'Srey Ka', '6264359963'),
  member('pich', 'Srey Pich', '7000000001'),
  member('neang', 'Srey Neang', '7000000002'),
  member('dara', 'Sok Dara', '7000000003'),
];
const BERY_ROEUN = { id: 1845110247, username: 'Bery_roeun' };
const THEARY = { id: 5757448268, username: null };
const BERY = { id: 2101995560, username: 'sunhiring' };
const SONY = { id: 5011482628, username: 'sony1681' };
const SEYI = { id: 7260836502, username: 'msiie09' };
const BIRY_ALIAS: StaffAlias[] = [{ normalized: 'biry', employee_id: 'bery' }];

test('staff: names lose hidden characters and titles', () => {
  assert.equal(normalizeStaffName('លោកគ្រូ​Bery'), 'bery');
  assert.equal(normalizeStaffName('លោកគ្រូប៊ីរី'), 'ប៊ីរី');
  assert.equal(normalizeStaffName(' អ្នកគ្រូ  ស្រីស្រស់ '), 'ស្រីស្រស់');
});

test('staff: a typed name matches by full name, name part, username or learned spelling', () => {
  assert.equal(findStaffByName(STAFF, [], 'Bery')?.employee_id, 'bery');
  assert.equal(findStaffByName(STAFF, [], 'សុនី')?.employee_id, 'sony');
  assert.equal(findStaffByName(STAFF, [], 'sony1681')?.employee_id, 'sony');
  assert.equal(findStaffByName(STAFF, [], 'Biry'), null);
  assert.equal(findStaffByName(STAFF, BIRY_ALIAS, 'Biry')?.employee_id, 'bery');
});

test('staff: sender by Telegram id, else by a username holding a registered name', () => {
  assert.deepEqual(resolveSender(STAFF, BERY.id, BERY.username), { member: STAFF[2], matched_by: 'id' });
  assert.equal(resolveSender(STAFF, BERY_ROEUN.id, BERY_ROEUN.username).member?.employee_id, 'bery');
  assert.equal(resolveSender(STAFF, BERY_ROEUN.id, BERY_ROEUN.username).matched_by, 'username');
  assert.equal(resolveSender(STAFF, SEYI.id, SEYI.username).member, null);
});

test('owner: staff typing a new spelling of their own name owns it, and it is learned', () => {
  const d = decideOwner(STAFF, [], BERY, 'Biry');
  assert.equal(d.owner?.employee_id, 'bery');
  assert.deepEqual(d.problems, []);
  assert.equal(d.learn_alias, 'biry');
});

test('owner: an admin may enter a report for someone else', () => {
  const d = decideOwner(STAFF, BIRY_ALIAS, THEARY, 'Biry');
  assert.equal(d.owner?.employee_id, 'bery');
  assert.equal(d.sender?.employee_id, 'theary');
  assert.deepEqual(d.problems, []);
});

test('owner: a username that looks like an admin gets no admin rights', () => {
  const d = decideOwner(STAFF, [], { id: 999, username: 'theary_fake' }, 'Bery');
  assert.equal(d.sender?.employee_id, 'theary');
  assert.deepEqual(d.problems, ['unregistered_sender', 'other_person']);
});

test('owner: regular staff naming another person is flagged and credited to themselves', () => {
  const d = decideOwner(STAFF, [], SONY, 'Bery');
  assert.equal(d.owner?.employee_id, 'sony');
  assert.deepEqual(d.problems, ['other_person']);
});

test('owner: an admin with a name nobody has is flagged, nothing learned', () => {
  const d = decideOwner(STAFF, [], THEARY, 'Nobody');
  assert.equal(d.owner, null);
  assert.deepEqual(d.problems, ['unknown_name']);
  assert.equal(d.learn_alias, null);
});

test('owner: unregistered account and missing name are flagged', () => {
  assert.deepEqual(decideOwner(STAFF, [], SEYI, 'Seie').problems, ['unregistered_sender', 'unknown_name']);
  const missing = decideOwner(STAFF, [], SONY, null);
  assert.deepEqual(missing.problems, ['missing_name']);
  assert.equal(missing.owner?.employee_id, 'sony');
});

test('directory: keeps the last roster when Payment-Tracker stops answering', async () => {
  let calls = 0;
  const dir = new StaffDirectory(async () => { if (calls++ === 0) return STAFF; throw new Error('down'); });
  assert.equal((await dir.list())?.length, STAFF.length);
  (dir as any).loadedAt = 0; // force a refresh
  assert.equal((await dir.list())?.length, STAFF.length);
  assert.equal(await new StaffDirectory(async () => null).list(), null);
});

// ── Bulk flow ────────────────────────────────────────────────────────────────

function fakeRepo(aliases: StaffAlias[] = []) {
  const saved: { events: any[]; summaries: any[]; audits: any[]; aliases: any[] } = { events: [], summaries: [], audits: [], aliases: [] };
  const repo = {
    getStaffAliases: async () => aliases,
    saveStaffAlias: async (...a: unknown[]) => { saved.aliases.push(a); },
    saveLeadEvents: async (evs: any[]) => { saved.events.push(...evs); return evs.map((_, i) => `e${i}`); },
    saveDailySummary: async (s: any) => { saved.summaries.push(s); return 's1'; },
    saveChangeLog: async () => undefined,
    logAudit: async (a: any) => { saved.audits.push(a); },
  };
  return { repo: repo as any, saved };
}

function fakeCtx(from: { id: number; username: string | null }) {
  const replies: string[] = [];
  const ctx: any = {
    from: { id: from.id, username: from.username ?? undefined },
    chat: { id: -100 },
    reply: async (text: string, extra?: any) => { replies.push(text); ctx.lastExtra = extra; },
    answerCbQuery: async () => undefined,
  };
  return { ctx, replies };
}

const tokenOf = (ctx: any): string =>
  ctx.lastExtra.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1];

test('bulk: admin pastes Bery\'s report — owner Bery, entered by Theary, saved on both', async () => {
  const { repo, saved } = fakeRepo(BIRY_ALIAS);
  const flow = new BulkEntryFlow(repo, new StaffDirectory(async () => STAFF));
  const { ctx, replies } = fakeCtx(THEARY);
  assert.equal(await flow.tryBulkEntry(ctx, FULL_FORMAT_REPORT), true);
  assert.match(replies[0], /Owner:<\/b> លោកគ្រូ​Bery · <i>entered by Theary Thoeurn<\/i>/);

  await flow.handleConfirm(ctx, tokenOf(ctx));
  assert.ok(saved.events.length > 0);
  for (const ev of saved.events) {
    assert.equal(ev.employee_id, 'bery');
    assert.equal(ev.follower, 'លោកគ្រូ​Bery');
    assert.equal(ev.entered_by.employee_id, 'theary');
  }
  assert.equal(saved.audits[0].parsed_result.employee_id, 'bery');
  assert.deepEqual(saved.aliases, []);
});

test('bulk: staff own report with a new spelling is saved and the spelling learned', async () => {
  const { repo, saved } = fakeRepo();
  const flow = new BulkEntryFlow(repo, new StaffDirectory(async () => STAFF));
  const { ctx } = fakeCtx(BERY);
  await flow.tryBulkEntry(ctx, FULL_FORMAT_REPORT);
  await flow.handleConfirm(ctx, tokenOf(ctx));
  assert.equal(saved.events[0].employee_id, 'bery');
  assert.deepEqual(saved.aliases, [['biry', 'bery', 'self']]);
});

test('bulk: problems warn by default and refuse when enforcement is on', async () => {
  const report = FULL_FORMAT_REPORT.replace('(Biry)', '(Bery)');
  const flow = new BulkEntryFlow(fakeRepo().repo, new StaffDirectory(async () => STAFF));

  const warn = fakeCtx(SONY);
  await flow.tryBulkEntry(warn.ctx, report);
  assert.match(warn.replies[0], /⚠️ «Bery» មិនមែនជាឈ្មោះរបស់អ្នកទេ/);
  assert.ok(warn.ctx.lastExtra?.reply_markup, 'warn mode still offers Confirm');

  process.env.STAFF_OWNERSHIP_ENFORCE = 'true';
  try {
    const strict = fakeCtx(SONY);
    await flow.tryBulkEntry(strict.ctx, report);
    assert.match(strict.replies[0], /^⚠️ មិនទាន់រក្សាទុកទេ/);
    assert.equal(strict.ctx.lastExtra, undefined, 'no Confirm button');
  } finally {
    delete process.env.STAFF_OWNERSHIP_ENFORCE;
  }
});

test('bulk: without a roster the typed (name) is stored, never the group name', async () => {
  const { repo, saved } = fakeRepo();
  const flow = new BulkEntryFlow(repo, new StaffDirectory(async () => null));
  const { ctx } = fakeCtx(SONY);
  await flow.tryBulkEntry(ctx, FULL_FORMAT_REPORT);
  await flow.handleConfirm(ctx, tokenOf(ctx));
  assert.equal(saved.events[0].follower, 'Biry');
  assert.equal(saved.events[0].employee_id, null);
  assert.equal(saved.events[0].entered_by.telegram_id, SONY.id);
});

const PICH = { id: 7000000001, username: null };
const NEANG = { id: 7000000002, username: null };

test('owner: the template placeholder is never a name, so it is never learned', () => {
  const d = decideOwner(STAFF, [], SONY, extractOwnerName('Page ឈ្មោះផេករបស់អ្នក (ឈ្មោះរបស់អ្នក)'));
  assert.equal(d.owner?.employee_id, 'sony');
  assert.deepEqual(d.problems, ['missing_name']);
  assert.equal(d.learn_alias, null);
});

test('owner: an ambiguous name ("Srey") is not learned for whoever typed it first', () => {
  const d = decideOwner(STAFF, [], PICH, 'Srey');
  assert.equal(d.owner?.employee_id, 'pich');
  assert.equal(d.learn_alias, null);
});

test('owner: an exact registered name beats a wrongly learned spelling', () => {
  const wrong: StaffAlias[] = [{ normalized: 'srey neang', employee_id: 'pich' }];
  assert.equal(decideOwner(STAFF, wrong, NEANG, 'Srey Neang').owner?.employee_id, 'neang');
});

test('sender: a username only matches a whole name part of 4+ letters, and is always flagged', () => {
  assert.equal(resolveSender(STAFF, 1, 'soksan_kh').member, null, '"sok" is too short to identify Sok Dara');
  assert.equal(resolveSender(STAFF, 1, 'berylin').member, null, '"bery" inside "berylin" is not a name part');
  assert.equal(decideOwner(STAFF, [], BERY_ROEUN, null).problems.includes('unregistered_sender'), true);
});
