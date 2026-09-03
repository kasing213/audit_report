/**
 * The worker-facing operations on a single proposal: prove ownership, mark
 * sent, mark failed.
 *
 * Extracted from the route handlers so the workspace-isolation rules can be
 * tested directly. Two invariants live here:
 *
 *  1. Every read and write is scoped by proposal id AND the worker's declared
 *     workspace, so a foreign proposal is "not found" and no cap, suppression,
 *     alert, or lead event is touched on the way to that answer.
 *  2. Payment Tracker never touches the sales side effects. A payment reminder
 *     is not a lead touch: it must not write a LeadEvent, must not start a
 *     180-day contact cooldown, and must not enter the phone-level suppression
 *     ledger. Its own terminal proposal — carrying the (phone, due date) dedupe
 *     key — is the suppression record.
 */
import { Logger } from '../utils/logger';
import { OrgId, PAYMENT_TRACKER_ORG } from './orgs';
import {
  OutreachProposalDocument,
  OutreachRepository,
  ProposalCollectionPort,
} from './outreach-repository';

/** Payment cap accounting. Only the payment branch calls these. */
export interface PaymentDeliveryPort {
  completePaymentDelivery(orgId: OrgId, now: Date): Promise<void>;
  releasePaymentDelivery(orgId: OrgId, now: Date): Promise<void>;
}

/**
 * Everything the SALES path does after a send. Grouped into one collaborator on
 * purpose: the payment path must call none of it, and a test can assert that by
 * checking this object was never touched.
 */
export interface SalesSideEffectsPort {
  recordDelivery(orgId: OrgId): Promise<void>;
  releaseClaim(orgId: OrgId): Promise<void>;
  recordContacted(proposal: OutreachProposalDocument, orgId: OrgId): Promise<void>;
  recordFailure(proposal: OutreachProposalDocument, orgId: OrgId, reason: string): Promise<string>;
  saveLeadEvent(proposal: OutreachProposalDocument, orgId: OrgId): Promise<void>;
  logAudit(proposal: OutreachProposalDocument): Promise<void>;
}

export interface FailureAlertPort {
  notifyFailure(proposal: OutreachProposalDocument, kind: string, reason: string): Promise<void>;
}

export interface WorkerProposalServiceDependencies {
  proposals: ProposalCollectionPort;
  workerState: PaymentDeliveryPort;
  sales: SalesSideEffectsPort;
  alerts: FailureAlertPort;
  clock?: () => Date;
}

export type WorkerResult =
  | { ok: true; proposal: OutreachProposalDocument }
  | { ok: false; status: 404 | 409; error: string };

export class WorkerProposalService {
  private readonly repo: OutreachRepository;
  private readonly now: () => Date;

  constructor(private readonly deps: WorkerProposalServiceDependencies) {
    this.repo = new OutreachRepository(deps.proposals);
    this.now = deps.clock ?? (() => new Date());
  }

  private isPayment(orgId: OrgId): boolean {
    return orgId === PAYMENT_TRACKER_ORG;
  }

  /**
   * Ownership proof for media lookups. Returns null for a proposal belonging to
   * another workspace, which the route surfaces as 404 — the worker learns
   * nothing about a proposal it may not have.
   */
  async ownedProposal(id: string, orgId: OrgId): Promise<OutreachProposalDocument | null> {
    return this.repo.getById(id, orgId);
  }

  async markSent(id: string, orgId: OrgId): Promise<WorkerResult> {
    const proposal = await this.repo.getById(id, orgId);
    if (!proposal) return { ok: false, status: 404, error: 'not found' };
    if (proposal.status !== 'in_flight') {
      return { ok: false, status: 409, error: `status is ${proposal.status}, expected in_flight` };
    }

    const marked = await this.repo.markSent(id, orgId);
    if (!marked) return { ok: false, status: 409, error: 'could not mark sent' };

    if (this.isPayment(orgId)) {
      // Converts the up-front reservation into a counted delivery. No lead
      // event, no contact cooldown, no suppression ledger entry.
      await this.deps.workerState.completePaymentDelivery(orgId, this.now()).catch((err) =>
        Logger.warn(`completePaymentDelivery on mark-sent: ${(err as Error).message}`)
      );
      return { ok: true, proposal };
    }

    await this.deps.sales.recordDelivery(orgId).catch((err) =>
      Logger.warn(`recordDelivery on mark-sent: ${(err as Error).message}`)
    );
    await this.deps.sales.recordContacted(proposal, orgId).catch((err) =>
      Logger.warn(`recordContacted on mark-sent: ${(err as Error).message}`)
    );
    await this.deps.sales.saveLeadEvent(proposal, orgId);
    await this.deps.sales.logAudit(proposal);
    return { ok: true, proposal };
  }

  async markFailed(id: string, orgId: OrgId, reason: string): Promise<WorkerResult> {
    const proposal = await this.repo.getById(id, orgId);
    if (!proposal) return { ok: false, status: 404, error: 'not found' };

    const marked = await this.repo.markFailed(id, orgId, reason);
    if (!marked) return { ok: false, status: 404, error: 'not found' };

    if (this.isPayment(orgId)) {
      // Hand the delivery slot back so a failed reminder does not consume one
      // of the day's fifteen. The failed proposal keeps its dedupe key, which
      // is what stops this phone/due-date being reminded again.
      await this.deps.workerState.releasePaymentDelivery(orgId, this.now()).catch((err) =>
        Logger.warn(`releasePaymentDelivery on mark-failed: ${(err as Error).message}`)
      );
    } else {
      let failureKind: string | undefined;
      try {
        failureKind = await this.deps.sales.recordFailure(proposal, orgId, reason);
      } catch (err) {
        Logger.warn(`recordFailure on mark-failed: ${(err as Error).message}`);
      }
      // Privacy/invalid/deferred failures stay counted against the day; only a
      // transient or unclassified failure gives its attempt slot back.
      if (failureKind === undefined || failureKind === 'transient') {
        await this.deps.sales.releaseClaim(orgId).catch((err) =>
          Logger.warn(`releaseClaim on mark-failed: ${(err as Error).message}`)
        );
      }
    }

    await this.deps.alerts.notifyFailure(proposal, 'mark-failed', reason).catch((err) =>
      Logger.warn(`failure alert: ${(err as Error).message}`)
    );
    return { ok: true, proposal };
  }
}
