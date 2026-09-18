import { ObjectId } from 'mongodb';
import { FunnelRates, UsdCents } from './types';

export type BusinessDate = string;
export type CampaignStatus = 'draft' | 'active' | 'archived';
export type ForecastRevisionStatus = 'draft' | 'approved';
export type ForecastRevisionKind = 'baseline' | 'revision';
export type SpendStatus = 'active' | 'archived';
export type SpendMode = 'daily' | 'monthly';

export interface CampaignInput {
  name: string;
  pageId: string;
  propertyProject?: string;
  objective?: string;
  audience?: string;
  spendMode?: SpendMode;
  startsOn: BusinessDate;
  endsOn: BusinessDate | null;
}

export interface Campaign extends CampaignInput {
  id: string;
  status: CampaignStatus;
  createdAt: Date;
  createdBy: string;
  archivedAt: Date | null;
  archivedBy: string | null;
}

export interface ForecastRevisionInput extends FunnelRates {
  month: string;
  monthlyBudgetCents: UsdCents;
}

export interface ForecastRevision extends ForecastRevisionInput {
  id: string;
  campaignId: string;
  revisionNumber: number;
  kind: ForecastRevisionKind;
  status: ForecastRevisionStatus;
  createdAt: Date;
  createdBy: string;
  approvedAt: Date | null;
  approvedBy: string | null;
}

export interface SpendInput {
  campaignId: string;
  month: string;
  businessDate: BusinessDate | null;
  amountCents: UsdCents;
}

export interface SpendRecord extends SpendInput {
  id: string;
  mode: SpendMode;
  status: SpendStatus;
  createdAt: Date;
  createdBy: string;
  archivedAt: Date | null;
  archivedBy: string | null;
}

export type LeadControlAuditAction =
  | 'campaign.created'
  | 'campaign.updated'
  | 'campaign.activated'
  | 'campaign.deleted'
  | 'campaign.archived'
  | 'forecast.draft_created'
  | 'forecast.draft_updated'
  | 'forecast.draft_deleted'
  | 'forecast.approved'
  | 'forecast.revision_created'
  | 'spend.recorded'
  | 'spend.updated'
  | 'spend.deleted'
  | 'spend.mode_switched';

export interface SalesProjectionDocument {
  _id: ObjectId;
  sale_id: string;
  status: string;
  normalized_phone: string;
  booking_date: Date;
  completed_date: Date | null;
  cancelled_date: Date | null;
  updated_at: Date;
  campaign_id: string | null;
  attributed_lead_id: string | null;
  attribution_kind: 'automatic' | 'manual' | 'unmatched';
  attributed_at: Date | null;
}

export interface SalesSyncCursorDocument {
  _id: 'sales';
  updated_at: Date;
  sale_id: string;
}

export interface MalformedSalesRecordDocument {
  _id: string;
  sale_id: string | null;
  reason: string;
  recorded_at: Date;
}

export interface SalesAuditEventDocument {
  _id: ObjectId;
  sale_id: string;
  action: string;
  actor: string;
  occurred_at: Date;
}

export interface AuditEvent {
  id: string;
  action: LeadControlAuditAction;
  actor: string;
  entityType: 'campaign' | 'forecast_revision' | 'spend';
  entityId: string;
  occurredAt: Date;
  details: Record<string, string | number | boolean | null>;
}

export interface CampaignDocument {
  _id: ObjectId;
  name: string;
  page_id: string;
  property_project?: string;
  objective?: string;
  audience?: string;
  spend_mode?: SpendMode;
  starts_on: BusinessDate;
  ends_on: BusinessDate | null;
  status: CampaignStatus;
  created_at: Date;
  created_by: string;
  archived_at: Date | null;
  archived_by: string | null;
}

export interface ForecastRevisionDocument {
  _id: ObjectId;
  campaign_id: ObjectId;
  month: string;
  monthly_budget_cents: UsdCents;
  cost_per_message_cents: UsdCents;
  message_to_phone_rate: number;
  phone_to_visit_rate: number;
  visit_to_booking_rate: number;
  cancellation_rate: number;
  revision_number: number;
  kind: ForecastRevisionKind;
  status: ForecastRevisionStatus;
  created_at: Date;
  created_by: string;
  approved_at: Date | null;
  approved_by: string | null;
}

export interface SpendRecordDocument {
  _id: ObjectId;
  campaign_id: ObjectId;
  month: string;
  business_date: BusinessDate | null;
  amount_cents: UsdCents;
  mode: SpendMode;
  status: SpendStatus;
  created_at: Date;
  created_by: string;
  archived_at: Date | null;
  archived_by: string | null;
}

export interface AuditEventDocument {
  _id: ObjectId;
  action: LeadControlAuditAction;
  actor: string;
  entity_type: AuditEvent['entityType'];
  entity_id: ObjectId;
  occurred_at: Date;
  details: Record<string, string | number | boolean | null>;
}
