import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IndexInspectionDatabase,
  verifyLeadControlIndexes,
} from '../../src/lead-control/index-verification';

type IndexSpec = { name: string; key: Record<string, 1 | -1>; unique?: boolean; sparse?: boolean; partialFilterExpression?: Record<string, unknown> };

const documentedIndexes: Record<string, IndexSpec[]> = {
  lead_control_campaigns: [
    { name: 'active_page_date_lookup', key: { page_id: 1, status: 1, starts_on: 1, ends_on: 1 } },
    { name: 'same_page_range_guard', key: { page_id: 1, starts_on: 1, ends_on: 1, status: 1 }, unique: true },
  ],
  lead_control_forecast_revisions: [
    { name: 'campaign_month_revision', key: { campaign_id: 1, month: 1, revision_number: 1 }, unique: true },
    { name: 'campaign_month_status', key: { campaign_id: 1, month: 1, status: 1 } },
  ],
  lead_control_spend_records: [
    { name: 'active_spend_record_guard', key: { campaign_id: 1, month: 1, business_date: 1 }, unique: true, partialFilterExpression: { status: 'active' } },
    { name: 'campaign_month_spend_lookup', key: { campaign_id: 1, month: 1, status: 1, mode: 1 } },
  ],
  lead_control_audit_events: [
    { name: 'entity_audit_history', key: { entity_type: 1, entity_id: 1, occurred_at: -1 } },
    { name: 'actor_audit_history', key: { actor: 1, occurred_at: -1 } },
  ],
  lead_control_mutation_guards: [{ name: 'mutation_guard_version', key: { version: 1 } }],
  lead_control_sales_projections: [
    { name: 'sale_id_unique', key: { sale_id: 1 }, unique: true },
    { name: 'phone_booking_lookup', key: { normalized_phone: 1, booking_date: 1 } },
    { name: 'campaign_booking_lookup', key: { campaign_id: 1, booking_date: 1 } },
    { name: 'unmatched_reconciliation_lookup', key: { attribution_kind: 1, updated_at: -1 } },
    { name: 'status_booking_lookup', key: { status: 1, booking_date: 1 } },
    { name: 'status_cancellation_event_lookup', key: { status: 1, cancelled_date: 1 } },
    { name: 'source_updated_cursor_lookup', key: { updated_at: 1, sale_id: 1 } },
  ],
  lead_control_malformed_sales: [{ name: 'malformed_sales_recorded_at', key: { recorded_at: -1 } }],
  lead_control_sales_audit_events: [{ name: 'sale_audit_history', key: { sale_id: 1, occurred_at: -1 } }],
  leads_events: [{ name: 'sale_attribution_normalized_phone_date', key: { normalized_phone: 1, date: -1, created_at: -1 }, sparse: true }],
  daily_summaries: [{ name: 'campaign_month_summary_lookup', key: { campaign_id: 1, date: 1 } }],
};

function fakeDatabase(indexes: Record<string, IndexSpec[]>): { db: IndexInspectionDatabase; inspected: string[] } {
  const inspected: string[] = [];
  return {
    inspected,
    db: {
      collection: (name: string) => ({
        listIndexes: () => ({
          toArray: async () => {
            inspected.push(name);
            return [{ name: '_id_', key: { _id: 1 } }, ...(indexes[name] ?? [])];
          },
        }),
      }),
    },
  };
}

// Production mutation caught: pre-release verification silently omits a documented collection or index.
test('index verification inspects every documented named index', async () => {
  const { db, inspected } = fakeDatabase(documentedIndexes);

  assert.deepEqual(await verifyLeadControlIndexes(db), { ok: true, missing: [] });
  assert.deepEqual(inspected.sort(), Object.keys(documentedIndexes).sort());
});

// Production mutation caught: a missing production index is reported as healthy.
test('index verification reports the exact missing collection and index', async () => {
  const withoutCursorIndex = {
    ...documentedIndexes,
    lead_control_sales_projections: documentedIndexes.lead_control_sales_projections.filter(
      (index) => index.name !== 'source_updated_cursor_lookup',
    ),
  };

  assert.deepEqual(await verifyLeadControlIndexes(fakeDatabase(withoutCursorIndex).db), {
    ok: false,
    missing: [{ collection: 'lead_control_sales_projections', index: 'source_updated_cursor_lookup' }],
  });
});

// Production mutation caught: a same-named index with reordered keys or weakened safety options passes release verification.
test('index verification rejects wrong key order and unique sparse or partial safety options', async () => {
  const unsafe = structuredClone(documentedIndexes);
  unsafe.lead_control_campaigns[1] = {
    ...unsafe.lead_control_campaigns[1],
    key: { starts_on: 1, page_id: 1, ends_on: 1, status: 1 },
    unique: false,
  };
  unsafe.lead_control_spend_records[0] = {
    ...unsafe.lead_control_spend_records[0],
    partialFilterExpression: { status: { $ne: 'archived' } },
  };
  unsafe.leads_events[0] = { ...unsafe.leads_events[0], sparse: false };

  assert.deepEqual(await verifyLeadControlIndexes(fakeDatabase(unsafe).db), {
    ok: false,
    missing: [
      { collection: 'lead_control_campaigns', index: 'same_page_range_guard' },
      { collection: 'lead_control_spend_records', index: 'active_spend_record_guard' },
      { collection: 'leads_events', index: 'sale_attribution_normalized_phone_date' },
    ],
  });
});
