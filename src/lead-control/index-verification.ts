export interface IndexInspectionDatabase {
  collection(name: string): {
    listIndexes(): { toArray(): Promise<Array<{ name?: string }>> };
  };
}

export interface MissingLeadControlIndex {
  collection: string;
  index: string;
}

export const REQUIRED_LEAD_CONTROL_INDEXES: Readonly<Record<string, readonly string[]>> = {
  lead_control_campaigns: ['active_page_date_lookup', 'same_page_range_guard'],
  lead_control_forecast_revisions: ['campaign_month_revision', 'campaign_month_status'],
  lead_control_spend_records: ['active_spend_record_guard', 'campaign_month_spend_lookup'],
  lead_control_audit_events: ['entity_audit_history', 'actor_audit_history'],
  lead_control_mutation_guards: ['mutation_guard_version'],
  lead_control_sales_projections: [
    'sale_id_unique',
    'phone_booking_lookup',
    'campaign_booking_lookup',
    'unmatched_reconciliation_lookup',
    'status_booking_lookup',
    'status_cancellation_event_lookup',
    'source_updated_cursor_lookup',
  ],
  lead_control_malformed_sales: ['malformed_sales_recorded_at'],
  lead_control_sales_audit_events: ['sale_audit_history'],
  leads_events: ['sale_attribution_normalized_phone_date'],
  daily_summaries: ['campaign_month_summary_lookup'],
};

/** Read actual Mongo index catalogs and identify every required named index that is absent. */
export async function verifyLeadControlIndexes(
  db: IndexInspectionDatabase,
): Promise<{ ok: boolean; missing: MissingLeadControlIndex[] }> {
  const missing: MissingLeadControlIndex[] = [];
  for (const [collection, required] of Object.entries(REQUIRED_LEAD_CONTROL_INDEXES)) {
    const existing = new Set((await db.collection(collection).listIndexes().toArray()).map((index) => index.name));
    for (const index of required) {
      if (!existing.has(index)) missing.push({ collection, index });
    }
  }
  return { ok: missing.length === 0, missing };
}
