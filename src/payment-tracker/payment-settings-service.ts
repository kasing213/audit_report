/**
 * Operator-facing Payment Tracker settings: wording, approval, Auto mode, and
 * the redacted source/scan status the dashboard shows.
 *
 * The activation rule lives here rather than in the route so it cannot be
 * bypassed by a second caller: Payment Auto may only be switched on when there
 * is wording AND that exact wording is currently approved. Turning Auto on also
 * approves the Payment drafts already waiting under Manual, so the batch
 * drafted before the switch is not stranded.
 */
import { OrgId, PAYMENT_TRACKER_ORG } from '../outreach/orgs';
import { OutreachRepository, ProposalCollectionPort } from '../outreach/outreach-repository';
import {
  PaymentTemplateDocument,
  PaymentTemplateRepository,
  isPaymentTemplateActive,
} from './payment-template-repository';
import { PaymentScanStateDocument } from './payment-scan-state-repository';

/** Refusal an operator can act on. Routes map this to HTTP 409. */
export class PaymentActivationError extends Error {}

const DEFAULT_AUTO_APPROVE_WINDOW = 5;

/** Same env var and fallback the sales auto-approval path uses. */
function defaultAutoApproveWindow(): number {
  const parsed = Number(process.env.OUTREACH_AUTO_APPROVE_WINDOW);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_AUTO_APPROVE_WINDOW;
}

export interface PaymentSettingsDependencies {
  templates: PaymentTemplateRepository;
  workerState: {
    getAutoApprove(orgId: OrgId): Promise<boolean>;
    setAutoApprove(orgId: OrgId, enabled: boolean): Promise<void>;
  };
  proposals: ProposalCollectionPort;
  scanState?: { get(): Promise<PaymentScanStateDocument> };
  /** Size of one auto-approval window. Matches the sales default. */
  autoApproveWindow?: () => number;
}

export interface PaymentSourceStatus {
  template_configured: boolean;
  template_approved: boolean;
  template_updated_at: Date | null;
  template_approved_by: string | null;
  auto_approve: boolean;
  scan_enabled: boolean;
  last_scan_at: Date | null;
  last_error_code: string | null;
  recent_summaries: PaymentScanStateDocument['summaries'];
}

export class PaymentSettingsService {
  private readonly repo: OutreachRepository;

  constructor(private readonly deps: PaymentSettingsDependencies) {
    this.repo = new OutreachRepository(deps.proposals);
  }

  async saveTemplate(text: string, actor: string): Promise<PaymentTemplateDocument> {
    return this.deps.templates.saveDraft(text, actor);
  }

  async approveTemplate(actor: string): Promise<PaymentTemplateDocument> {
    return this.deps.templates.approve(actor);
  }

  /**
   * Switch Payment Auto on or off.
   *
   * Turning it on without approved wording is refused before any state changes,
   * so a failed activation cannot leave Auto enabled with nothing to send.
   * Bulk approval is scoped to payment_tracker — it must never touch a Company
   * or Personal pending draft.
   */
  async setAutoApprove(enabled: boolean, actor: string): Promise<{ approved: number }> {
    if (enabled) {
      const template = await this.deps.templates.get();
      if (!isPaymentTemplateActive(template)) {
        throw new PaymentActivationError(
          'approve the payment reminder wording before turning Auto on'
        );
      }
    }

    await this.deps.workerState.setAutoApprove(PAYMENT_TRACKER_ORG, enabled);
    if (!enabled) return { approved: 0 };

    // Release one bounded window rather than every pending draft, matching the
    // sales pipeline. It matters more here, not less: these messages tell
    // customers they owe money, so a mistake should reach a handful of people
    // before the next window opens, not the whole ledger at once. The window
    // only reopens once nothing is approved or in flight.
    const approved = await this.repo.approveNextPendingWindow(
      PAYMENT_TRACKER_ORG,
      actor,
      (this.deps.autoApproveWindow ?? defaultAutoApproveWindow)()
    );
    return { approved };
  }

  /** Redacted status for the dashboard. Never a URI or any customer field. */
  async getSourceStatus(): Promise<PaymentSourceStatus> {
    const template = await this.deps.templates.get();
    const scan = (await this.deps.scanState?.get()) ?? null;

    return {
      template_configured: Boolean(template && template.template_text.trim().length > 0),
      template_approved: isPaymentTemplateActive(template),
      template_updated_at: template?.updated_at ?? null,
      template_approved_by: template?.approved_by ?? null,
      auto_approve: await this.deps.workerState.getAutoApprove(PAYMENT_TRACKER_ORG),
      scan_enabled: process.env.PAYMENT_TRACKER_SCAN_ENABLED === 'true',
      last_scan_at: scan?.last_scan_at ?? null,
      last_error_code: scan?.last_error_code ?? null,
      recent_summaries: scan?.summaries ?? [],
    };
  }
}
