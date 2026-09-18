export const MIN_LEAD_CONTROL_SYNC_INTERVAL_MINUTES = 5;
export const MAX_LEAD_CONTROL_SYNC_INTERVAL_MINUTES = 60;

export interface LeadControlConfig {
  writesEnabled: boolean;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
}

/** Parse deployment controls once. Sensitive capabilities stay off unless explicitly enabled. */
export function readLeadControlConfig(env: NodeJS.ProcessEnv): LeadControlConfig {
  const rawInterval = env.LEAD_CONTROL_SYNC_INTERVAL_MINUTES ?? '15';
  const syncIntervalMinutes = Number(rawInterval);
  if (
    !Number.isInteger(syncIntervalMinutes)
    || syncIntervalMinutes < MIN_LEAD_CONTROL_SYNC_INTERVAL_MINUTES
    || syncIntervalMinutes > MAX_LEAD_CONTROL_SYNC_INTERVAL_MINUTES
  ) {
    throw new Error(
      `LEAD_CONTROL_SYNC_INTERVAL_MINUTES must be an integer from ${MIN_LEAD_CONTROL_SYNC_INTERVAL_MINUTES} through ${MAX_LEAD_CONTROL_SYNC_INTERVAL_MINUTES}`,
    );
  }

  return {
    writesEnabled: env.LEAD_CONTROL_WRITES_ENABLED === 'true',
    syncEnabled: env.LEAD_CONTROL_SYNC_ENABLED === 'true',
    syncIntervalMinutes,
  };
}
