import { Logger } from '../utils/logger';
import { fetchStaffFromPaymentTracker } from '../integrations/payment-tracker-api';

// Who owns a report. Payment-Tracker holds the staff roster; this module
// matches a report's sender (Telegram account) and the `(name)` typed on its
// Page line against it. audit-sales keeps only learned name spellings
// (staff_name_aliases), never its own copy of the roster.

export interface StaffMember {
  employee_id: string;
  name: string;
  status: string;            // ACTIVE | INACTIVE
  role: string;              // SALES | STAFF | BOSS
  telegram_chat_id: string | null;
  telegram_username: string | null;
  is_admin: boolean;         // BOSS or group ADMIN — may submit for others
}

export interface StaffAlias {
  normalized: string;
  employee_id: string;
}

export type OwnerProblem = 'missing_name' | 'unknown_name' | 'other_person' | 'unregistered_sender';

export interface OwnerDecision {
  owner: StaffMember | null;
  sender: StaffMember | null;
  sender_matched_by: 'id' | 'username' | null;
  owner_name: string | null;   // the `(name)` as typed
  problems: OwnerProblem[];
  learn_alias: string | null;  // normalized spelling to remember for `owner`
}

export interface EnteredBy {
  telegram_id: number;
  username: string | null;
  employee_id: string | null;
  name: string | null;
}

const ZERO_WIDTH = /[​-‍﻿]/g;
const TITLE = /^(?:លោកគ្រូ|អ្នកគ្រូ|គ្រូ|mrs|mr|ms|miss)\.?\s*/i;

/** Lowercase, hidden characters and titles (លោកគ្រូ, អ្នកគ្រូ, គ្រូ, Mr…) removed. */
export function normalizeStaffName(raw: string): string {
  return raw.replace(ZERO_WIDTH, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(TITLE, '').trim();
}

function nameKeys(m: StaffMember): string[] {
  const name = normalizeStaffName(m.name);
  const keys = new Set([name, name.replace(/\s/g, '')]);
  for (const token of name.split(' ')) if (token.length >= 2) keys.add(token);
  if (m.telegram_username) keys.add(m.telegram_username.toLowerCase());
  return [...keys].filter(Boolean);
}

function pickOne(hits: StaffMember[]): StaffMember | null {
  const unique = [...new Map(hits.map(h => [h.employee_id, h])).values()];
  if (unique.length === 1) return unique[0];
  const active = unique.filter(h => h.status === 'ACTIVE');
  return active.length === 1 ? active[0] : null;
}

/** Roster entries a typed (normalized) name could mean: full name, name part or username. */
function rosterMatches(staff: StaffMember[], n: string): StaffMember[] {
  const compact = n.replace(/\s/g, '');
  return staff.filter(s => nameKeys(s).some(k => k === n || k === compact));
}

/** A typed name → one employee: exact registered name first, then learned spelling, then name part or username. Ambiguous → null. */
export function findStaffByName(staff: StaffMember[], aliases: StaffAlias[], text: string): StaffMember | null {
  const n = normalizeStaffName(text);
  if (!n) return null;
  // A registered full name always beats a learned spelling, so one wrong
  // learned alias can't keep taking the real person's reports.
  const compact = n.replace(/\s/g, '');
  const exact = pickOne(staff.filter(s => normalizeStaffName(s.name).replace(/\s/g, '') === compact));
  if (exact) return exact;
  const byAlias = aliases
    .filter(a => a.normalized === n)
    .map(a => staff.find(s => s.employee_id === a.employee_id))
    .filter((s): s is StaffMember => !!s);
  if (byAlias.length) return pickOne(byAlias);
  return pickOne(rosterMatches(staff, n));
}

/**
 * The sender's employee: by Telegram id, else (an account not registered)
 * by a username that contains a registered name, e.g. Bery_roeun → Bery.
 */
export function resolveSender(
  staff: StaffMember[],
  telegramId: number,
  username: string | null,
): { member: StaffMember | null; matched_by: 'id' | 'username' | null } {
  const byId = staff.find(s => s.telegram_chat_id === String(telegramId));
  if (byId) return { member: byId, matched_by: 'id' };
  if (username) {
    // Whole parts only ("bery" in Bery_roeun, not in berylin), 4+ letters.
    const parts = new Set(username.toLowerCase().split(/[^\p{L}\p{M}]+/u));
    const hit = pickOne(staff.filter(s =>
      s.status === 'ACTIVE' && normalizeStaffName(s.name).split(' ').some(t => t.length >= 4 && parts.has(t))));
    if (hit) return { member: hit, matched_by: 'username' };
  }
  return { member: null, matched_by: null };
}

/**
 * Decide whose report this is. Staff report for themselves; an admin/Boss may
 * report for someone else. A name nobody has yet, typed by a staff member for
 * their own report, becomes that person's learned spelling.
 */
export function decideOwner(
  staff: StaffMember[],
  aliases: StaffAlias[],
  from: { id: number; username: string | null },
  ownerName: string | null,
): OwnerDecision {
  const { member: sender, matched_by } = resolveSender(staff, from.id, from.username);
  // A username match is a guess about an account nobody registered: flag it.
  const problems: OwnerProblem[] = matched_by === 'id' ? [] : ['unregistered_sender'];
  const base = { sender, sender_matched_by: matched_by, owner_name: ownerName, learn_alias: null };
  // A username is self-chosen: it may identify the sender, never grant admin.
  const isAdmin = matched_by === 'id' && !!sender?.is_admin;

  if (!ownerName) {
    return { ...base, owner: sender, problems: [...problems, 'missing_name'] };
  }
  const named = findStaffByName(staff, aliases, ownerName);
  if (named) {
    if (sender && named.employee_id !== sender.employee_id && !isAdmin) {
      // Usually a colleague's report text pasted as-is: credit who sent it.
      return { ...base, owner: sender, problems: [...problems, 'other_person'] };
    }
    return { ...base, owner: named, problems };
  }
  if (sender && !isAdmin) {
    // Learn a new spelling only if it could mean nobody else ("Srey" could mean several people).
    const learnable = matched_by === 'id' && rosterMatches(staff, normalizeStaffName(ownerName)).length === 0;
    return { ...base, owner: sender, problems, learn_alias: learnable ? normalizeStaffName(ownerName) : null };
  }
  return { ...base, owner: null, problems: [...problems, 'unknown_name'] };
}

export function enteredBy(sender: StaffMember | null | undefined, from: { id: number; username: string | null }): EnteredBy {
  return {
    telegram_id: from.id,
    username: from.username,
    employee_id: sender?.employee_id ?? null,
    name: sender?.name ?? null,
  };
}

/** When on, a report with an owner problem is refused instead of saved with a warning. */
export function staffOwnershipEnforced(): boolean {
  return process.env.STAFF_OWNERSHIP_ENFORCE === 'true';
}

const PROBLEM_TEXT: Record<OwnerProblem, (d: OwnerDecision) => string> = {
  missing_name: () => 'សូមដាក់ឈ្មោះរបស់អ្នកក្នុងវង់ក្រចក នៅបន្ទាត់ Page ឧ. 🚩Page Sun Tv (Bery)',
  unknown_name: d => `រកមិនឃើញឈ្មោះ «${d.owner_name}» ក្នុងបញ្ជីបុគ្គលិកទេ`,
  other_person: d => `«${d.owner_name}» មិនមែនជាឈ្មោះរបស់អ្នកទេ — រក្សាទុកក្រោមឈ្មោះ ${d.owner?.name}។ មានតែ admin ទេដែលអាចបញ្ចូលជំនួសគេបាន`,
  unregistered_sender: () => 'គណនី Telegram នេះមិនទាន់បានចុះឈ្មោះជាបុគ្គលិកទេ',
};

export function describeProblems(decision: OwnerDecision): string[] {
  return decision.problems.map(p => PROBLEM_TEXT[p](decision));
}

const TTL_MS = 5 * 60 * 1000;

/** Cached roster. list() is null when Payment-Tracker isn't configured or never answered. */
export class StaffDirectory {
  private staff: StaffMember[] | null = null;
  private loadedAt = 0;

  constructor(private readonly fetcher: () => Promise<StaffMember[] | null> = fetchStaffFromPaymentTracker) {}

  async list(): Promise<StaffMember[] | null> {
    if (this.staff && Date.now() - this.loadedAt < TTL_MS) return this.staff;
    try {
      const fresh = await this.fetcher();
      if (fresh) {
        this.staff = fresh;
        this.loadedAt = Date.now();
      }
    } catch (error) {
      Logger.warn(`Staff roster unavailable, using last copy: ${(error as Error).message}`);
    }
    return this.staff;
  }
}

export const staffDirectory = new StaffDirectory();

type AliasSource = { getStaffAliases(): Promise<StaffAlias[]> };

/** Roster + learned spellings; null when there is no roster to check against. */
export async function loadRoster(
  directory: StaffDirectory,
  aliasSource: AliasSource,
): Promise<{ staff: StaffMember[]; aliases: StaffAlias[] } | null> {
  const staff = await directory.list();
  if (!staff) return null;
  const aliases = await aliasSource.getStaffAliases().catch(() => [] as StaffAlias[]);
  return { staff, aliases };
}

/** decideOwner against the live roster; null when there is no roster to check against. */
export async function resolveReportOwner(
  directory: StaffDirectory,
  aliasSource: AliasSource,
  from: { id: number; username: string | null },
  ownerName: string | null,
): Promise<OwnerDecision | null> {
  const roster = await loadRoster(directory, aliasSource);
  return roster ? decideOwner(roster.staff, roster.aliases, from, ownerName) : null;
}
