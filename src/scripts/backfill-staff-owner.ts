/**
 * Re-credit Bulk and Close-sell records to the employee who owns them.
 *
 * Bulk records before the staff check carry "Jim" (a name line copied from
 * Bery's report) or the group name as follower. The owner is the `(name)` on
 * the Page line, checked against the sender — the same rule the bot now uses
 * (src/staff/staff-resolver.ts). Close-sell records get the sender, follower
 * and closer ids; their typed follower is left as is.
 *
 * Usage (prints the plan; writes nothing):
 *   railway run npx ts-node src/scripts/backfill-staff-owner.ts
 * Options:
 *   --staff-file=staff.json        roster as GET /api/staff returns it (default: the API)
 *   --account=<telegramId>:<employee_id>   an old account of a registered employee
 *                                  (repeatable), e.g. Theary's @Sunnimex
 *   --alias=<spelling>:<employee_id>        a spelling someone else typed for an
 *                                  employee (repeatable), e.g. ប៊ីរី for Bery
 *   --apply                        write the changes and save learned spellings
 */

import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { ObjectId } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { extractOwnerName } from '../parser/bulk-report-parser';
import { fetchStaffFromPaymentTracker } from '../integrations/payment-tracker-api';
import {
  StaffMember, StaffAlias, decideOwner, findStaffByName, resolveSender, enteredBy, normalizeStaffName,
} from '../staff/staff-resolver';

dotenv.config();

// Name lines that never meant a person.
const NOT_A_NAME = new Set(['jim', 'sales-management-group', 'yourname']);

function arg(name: string): string[] {
  return process.argv.slice(2).filter(a => a.startsWith(`--${name}=`)).map(a => a.slice(name.length + 3));
}

async function loadStaff(): Promise<StaffMember[]> {
  const [file] = arg('staff-file');
  const staff = file ? (JSON.parse(readFileSync(file, 'utf8')).staff as StaffMember[]) : await fetchStaffFromPaymentTracker();
  if (!staff?.length) throw new Error('No staff roster: set PAYMENT_TRACKER_API_URL/KEY or pass --staff-file');
  return staff;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const staff = await loadStaff();
  // Old accounts → that employee's registered Telegram id.
  const accounts = new Map(arg('account').map(a => {
    const [tg, emp] = a.split(':');
    const m = staff.find(s => s.employee_id === emp);
    if (!m?.telegram_chat_id) throw new Error(`--account ${a}: unknown employee or no Telegram id`);
    return [Number(tg), Number(m.telegram_chat_id)] as const;
  }));

  const conn = DatabaseConnection.getInstance();
  await conn.connect();
  const db = conn.getDb();
  const events = db.collection('leads_events');
  const summaries = db.collection('daily_summaries');
  const logs = await db.collection('audit_logs')
    .find({ action: { $in: ['bulk-telegram', 'closesell-telegram'] } }).sort({ timestamp: 1 }).toArray();
  const aliases: StaffAlias[] = (await db.collection('staff_name_aliases').find({}).toArray())
    .map(a => ({ normalized: a.normalized, employee_id: a.employee_id }));

  const bulkOwnerName = (log: any): string | null => {
    const h = log.parsed_result?.header ?? {};
    const typed = extractOwnerName(h.page ?? null) ?? h.follower ?? null;
    return typed && !NOT_A_NAME.has(normalizeStaffName(typed)) ? typed : null;
  };
  const sender = (log: any) => ({ id: accounts.get(log.user_id) ?? log.user_id, username: log.username ?? null });

  // Pass 1: spellings staff used for their own reports, so admin-entered ones resolve too.
  const learned: StaffAlias[] = arg('alias').map(a => {
    const i = a.lastIndexOf(':');
    const employee_id = a.slice(i + 1);
    if (!staff.some(m => m.employee_id === employee_id)) throw new Error(`--alias ${a}: unknown employee`);
    return { normalized: normalizeStaffName(a.slice(0, i)), employee_id };
  });
  for (const log of logs.filter(l => l.action === 'bulk-telegram')) {
    const d = decideOwner(staff, [...aliases, ...learned], sender(log), bulkOwnerName(log));
    if (d.learn_alias && d.owner && !learned.some(a => a.normalized === d.learn_alias)) {
      learned.push({ normalized: d.learn_alias, employee_id: d.owner.employee_id });
    }
  }
  const allAliases = [...aliases, ...learned];

  // Pass 2: the plan.
  let changes = 0;
  for (const log of logs) {
    const from = sender(log);
    const by = enteredBy(resolveSender(staff, from.id, from.username).member, { id: log.user_id, username: log.username ?? null });
    const when = new Date(log.timestamp).toISOString().slice(0, 10);

    if (log.action === 'bulk-telegram') {
      const ids: string[] = log.parsed_result?.event_ids ?? [];
      const typed = bulkOwnerName(log);
      const d = decideOwner(staff, allAliases, from, typed);
      const set = { follower: d.owner?.name ?? typed, employee_id: d.owner?.employee_id ?? null, entered_by: by };
      const old = ids.length ? (await events.findOne({ _id: new ObjectId(ids[0]) }))?.follower : log.parsed_result?.header?.follower;
      console.log(`${when} bulk  @${log.username ?? log.user_id}  (${typed ?? '—'})  ${old ?? '—'} → ${set.follower ?? '—'}` +
        `  [${ids.length} rec]${d.problems.length ? '  ⚠ ' + d.problems.join(',') : ''}`);
      if (!set.follower) continue;
      changes += ids.length;
      if (apply) {
        if (ids.length) await events.updateMany({ _id: { $in: ids.map(i => new ObjectId(i)) } }, { $set: set });
        if (log.parsed_result?.summary_id) await summaries.updateOne({ _id: new ObjectId(log.parsed_result.summary_id) }, { $set: set });
      }
    } else {
      const id = log.parsed_result?.event_id;
      const ev = id ? await events.findOne({ _id: new ObjectId(id) }) : null;
      if (!ev) continue;
      const closer = String(ev.note ?? '').match(/អ្នកបិទលក់៖ ([^;]+)/)?.[1]?.trim() ?? null;
      const set = {
        employee_id: ev.follower ? findStaffByName(staff, allAliases, ev.follower)?.employee_id ?? null : null,
        closer_employee_id: closer ? findStaffByName(staff, allAliases, closer)?.employee_id ?? null : null,
        entered_by: by,
      };
      console.log(`${when} close @${log.username ?? log.user_id}  follower ${ev.follower ?? '—'} → ${set.employee_id ?? '?'}  closer ${closer ?? '—'} → ${set.closer_employee_id ?? '?'}`);
      changes++;
      if (apply) await events.updateOne({ _id: ev._id }, { $set: set });
    }
  }

  console.log(`\nLearned spellings: ${learned.map(a => `${a.normalized}→${a.employee_id}`).join(', ') || 'none'}`);
  if (apply) {
    for (const a of learned) {
      await db.collection('staff_name_aliases').updateOne(
        { normalized: a.normalized },
        { $setOnInsert: { ...a, source: 'backfill', created_at: new Date() } },
        { upsert: true },
      );
    }
  }
  console.log(`${apply ? 'Updated' : 'Would update'} ${changes} records.${apply ? '' : ' Re-run with --apply to write.'}`);
  await conn.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
