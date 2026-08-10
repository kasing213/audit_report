// src/outreach/outreach-media-budget.ts
/**
 * Shared byte budget across ALL default outreach media for an org — primary
 * image, primary video, and every extra image/video. There is no per-item
 * count cap; only this combined size gates adding more media. See
 * docs/superpowers/specs/2026-08-10-outreach-extra-media-design.md.
 */
import { OutreachImagesRepository } from './outreach-images-repository';
import { OutreachVideoRepository } from './outreach-video-repository';
import { OrgId, DEFAULT_ORG } from './orgs';

export const MEDIA_BUDGET_BYTES = 50 * 1024 * 1024; // 50MB

export interface MediaUsage {
  totalBytes: number;
  budgetBytes: number;
}

export async function getMediaUsage(orgId: OrgId = DEFAULT_ORG): Promise<MediaUsage> {
  const imagesRepo = new OutreachImagesRepository();
  const videoRepo = new OutreachVideoRepository();
  const [primaryImage, primaryVideo, extraImageBytes, extraVideoBytes] = await Promise.all([
    imagesRepo.getDefault(orgId),
    videoRepo.getDefault(orgId),
    imagesRepo.sumExtraBytes(orgId),
    videoRepo.sumExtraBytes(orgId),
  ]);
  const totalBytes =
    (primaryImage?.size_bytes || 0) +
    (primaryVideo?.size_bytes || 0) +
    extraImageBytes +
    extraVideoBytes;
  return { totalBytes, budgetBytes: MEDIA_BUDGET_BYTES };
}

export type BudgetCheck =
  | { ok: true }
  | { ok: false; totalBytes: number; budgetBytes: number; attemptedBytes: number };

/**
 * Would adding `additionalBytes` push the org over budget? Pass
 * `excludeCurrentPrimaryBytes` when replacing a primary doc in place (its old
 * size shouldn't count against the new upload — a same-size replace should
 * never trip the budget).
 */
export async function checkBudget(
  orgId: OrgId,
  additionalBytes: number,
  excludeCurrentPrimaryBytes = 0
): Promise<BudgetCheck> {
  const usage = await getMediaUsage(orgId);
  const projected = usage.totalBytes - excludeCurrentPrimaryBytes + additionalBytes;
  if (projected > MEDIA_BUDGET_BYTES) {
    return { ok: false, totalBytes: usage.totalBytes, budgetBytes: MEDIA_BUDGET_BYTES, attemptedBytes: additionalBytes };
  }
  return { ok: true };
}
