import { randomUUID } from 'crypto';
import { SalesCaseRepository } from '../database/repository';
import { CustomerCase } from '../database/models';
import { Logger } from '../utils/logger';
import { toInternationalPhone } from '../utils/phone-utils';
import { OutreachRepository, OutreachProposalDocument } from './outreach-repository';
import { OutreachSuppressionRepository } from './outreach-suppression-repository';
import { getStaticOutreachMessage } from './static-template';

const DEFAULT_STALE_DAYS = 45;
const DEFAULT_BATCH_LIMIT = 20;

export interface GenerateOptions {
  limit?: number;
  followerFilter?: string;
  phones?: string[];
  staleDays?: number;
  /** Skip the suppression filter (used by the explicit backup-retry path). */
  bypassSuppression?: boolean;
  /** Create proposals as 'approved' (auto-retry) instead of 'pending'. */
  autoApprove?: boolean;
}

export interface GenerateResult {
  generation_id: string;
  requested: number;
  created: number;
  skipped: number;
  errored: number;
  details: Array<{
    phone: string;
    outcome: 'created' | 'skipped' | 'errored' | 'duplicate';
    reason?: string;
  }>;
}

function daysSince(dateString: string | null | undefined): number | null {
  if (!dateString) return null;
  const parsed = new Date(dateString).getTime();
  if (Number.isNaN(parsed)) return null;
  return Math.floor((Date.now() - parsed) / (1000 * 60 * 60 * 24));
}

async function selectCandidates(
  salesRepo: SalesCaseRepository,
  opts: GenerateOptions
): Promise<CustomerCase[]> {
  if (opts.phones && opts.phones.length > 0) {
    const wanted = new Set(opts.phones.map((p) => toInternationalPhone(p.trim())));
    const all = await salesRepo.getAllCustomers();
    return all.filter((c) => c.phone && wanted.has(toInternationalPhone(c.phone.trim())));
  }

  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const candidates = await salesRepo.getStaleCustomers(staleDays, opts.followerFilter);
  if (opts.bypassSuppression) {
    return candidates.slice(0, opts.limit ?? DEFAULT_BATCH_LIMIT);
  }
  // Drop phones on the suppression list BEFORE slicing, so a batch isn't wasted
  // on numbers that already failed (privacy/invalid). See OutreachSuppressionRepository.
  const suppressed = await new OutreachSuppressionRepository().getSuppressedPhones();
  return candidates
    .filter((c) => c.phone && !suppressed.has(toInternationalPhone(c.phone.trim())))
    .slice(0, opts.limit ?? DEFAULT_BATCH_LIMIT);
}

export async function generateBatch(opts: GenerateOptions): Promise<GenerateResult> {
  const salesRepo = new SalesCaseRepository();
  const outreachRepo = new OutreachRepository();
  const generationId = randomUUID();
  const details: GenerateResult['details'] = [];
  const toInsert: OutreachProposalDocument[] = [];

  const candidates = await selectCandidates(salesRepo, opts);
  Logger.info(`outreach.generateBatch(${generationId}): ${candidates.length} candidates`);
  const staticMessage = await getStaticOutreachMessage();

  for (const customer of candidates) {
    if (!customer.phone) {
      details.push({ phone: '(none)', outcome: 'skipped', reason: 'no phone' });
      continue;
    }

    const intlPhone = toInternationalPhone(customer.phone.trim());

    if (await outreachRepo.hasRecentProposalForPhone(intlPhone)) {
      details.push({ phone: intlPhone, outcome: 'duplicate', reason: 'proposal within 14 days' });
      continue;
    }

    // AI generation disabled: send a fixed Khmer template, held for manual approval
    // (or auto-approved when this is an automated backup retry).
    const now = new Date();
    toInsert.push({
      generation_id: generationId,
      customer_phone: intlPhone,
      customer_name: customer.name,
      reason_code: customer.current_reason_code ?? null,
      days_since_contact: daysSince(customer.last_update_date),
      follower: customer.follower,
      message: staticMessage,
      reasoning: opts.autoApprove
        ? 'static template (auto-approved backup retry)'
        : 'static template (AI generation disabled)',
      status: opts.autoApprove ? 'approved' : 'pending',
      skipped_reason: null,
      failed_reason: null,
      custom_image_id: null,
      created_at: now,
      approved_at: opts.autoApprove ? now : null,
      approved_by: opts.autoApprove ? 'auto-retry' : null,
      sent_at: null,
      lease_expires_at: null,
      model: 'static',
    });
    details.push({ phone: intlPhone, outcome: 'created' });
  }

  if (toInsert.length > 0) {
    await outreachRepo.insertMany(toInsert);
  }

  return {
    generation_id: generationId,
    requested: candidates.length,
    created: details.filter((d) => d.outcome === 'created').length,
    skipped: details.filter((d) => d.outcome === 'skipped' || d.outcome === 'duplicate').length,
    errored: details.filter((d) => d.outcome === 'errored').length,
    details,
  };
}
