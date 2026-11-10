import { createHash } from 'crypto';

/** Same report pasted again (every field equal) → same hash; any change → a different one. */
export function reportHash(r: {
  date: string;
  page: string | null | undefined;
  owner: string | null;
  counters: unknown;
  drafts: unknown[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify([r.date, r.page ?? null, r.owner, r.counters ?? {}, r.drafts]))
    .digest('hex');
}
