import { randomUUID } from 'crypto';
import { SalesCaseRepository } from '../database/repository';
import { CustomerCase } from '../database/models';
import { Logger } from '../utils/logger';
import { toInternationalPhone } from '../utils/phone-utils';
import { draftMessage, reviewMessage } from './openai-drafter';
import { OutreachRepository, OutreachProposalDocument } from './outreach-repository';
import { canAutoApprove, isAutoApproveEnabled } from './auto-approve-gate';

const DEFAULT_STALE_DAYS = 45;
const DEFAULT_BATCH_LIMIT = 10;

export interface GenerateOptions {
  limit?: number;
  followerFilter?: string;
  phones?: string[];
  staleDays?: number;
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
  return candidates.slice(0, opts.limit ?? DEFAULT_BATCH_LIMIT);
}

export async function generateBatch(opts: GenerateOptions): Promise<GenerateResult> {
  const salesRepo = new SalesCaseRepository();
  const outreachRepo = new OutreachRepository();
  const generationId = randomUUID();
  const details: GenerateResult['details'] = [];
  const toInsert: OutreachProposalDocument[] = [];

  const candidates = await selectCandidates(salesRepo, opts);
  Logger.info(`outreach.generateBatch(${generationId}): ${candidates.length} candidates`);

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

    const draft = await draftMessage(customer);
    if (!draft) {
      details.push({ phone: intlPhone, outcome: 'errored', reason: 'drafter failed' });
      continue;
    }

    const review = await reviewMessage(draft.message, customer);
    const now = new Date();

    if (!review) {
      // Reviewer failed entirely — err on the safe side, mark as pending but flag reasoning.
      toInsert.push({
        generation_id: generationId,
        customer_phone: intlPhone,
        customer_name: customer.name,
        reason_code: customer.current_reason_code ?? null,
        days_since_contact: daysSince(customer.last_update_date),
        follower: customer.follower,
        message: draft.message,
        reasoning: `${draft.reasoning} (reviewer unavailable)`,
        status: 'pending',
        skipped_reason: null,
        failed_reason: null,
        custom_image_id: null,
        created_at: now,
        approved_at: null,
        approved_by: null,
        sent_at: null,
        lease_expires_at: null,
        model: draft.model,
      });
      details.push({ phone: intlPhone, outcome: 'created', reason: 'reviewer unavailable' });
      continue;
    }

    if (review.approve) {
      const autoApprove = isAutoApproveEnabled() ? canAutoApprove(draft, customer, review) : { ok: false, reason: 'auto-approve disabled' };
      Logger.info(`outreach.autoApprove[${intlPhone}]: ${autoApprove.ok ? 'PASS' : 'HOLD'} — ${autoApprove.reason}`);

      const isAuto = autoApprove.ok;
      toInsert.push({
        generation_id: generationId,
        customer_phone: intlPhone,
        customer_name: customer.name,
        reason_code: customer.current_reason_code ?? null,
        days_since_contact: daysSince(customer.last_update_date),
        follower: customer.follower,
        message: draft.message,
        reasoning: draft.reasoning,
        status: isAuto ? 'approved' : 'pending',
        skipped_reason: null,
        failed_reason: null,
        custom_image_id: null,
        created_at: now,
        approved_at: isAuto ? now : null,
        approved_by: isAuto ? 'auto' : null,
        sent_at: null,
        lease_expires_at: null,
        model: draft.model,
      });
      if (isAuto) {
        details.push({ phone: intlPhone, outcome: 'created', reason: 'auto-approved' });
      } else {
        details.push({ phone: intlPhone, outcome: 'created' });
      }
    } else {
      toInsert.push({
        generation_id: generationId,
        customer_phone: intlPhone,
        customer_name: customer.name,
        reason_code: customer.current_reason_code ?? null,
        days_since_contact: daysSince(customer.last_update_date),
        follower: customer.follower,
        message: draft.message,
        reasoning: draft.reasoning,
        status: 'skipped',
        skipped_reason: review.reason,
        failed_reason: null,
        custom_image_id: null,
        created_at: now,
        approved_at: null,
        approved_by: null,
        sent_at: null,
        lease_expires_at: null,
        model: draft.model,
      });
      details.push({ phone: intlPhone, outcome: 'skipped', reason: review.reason });
    }
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
