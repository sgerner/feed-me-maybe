import type { RequestHandler } from './$types';
import {
  listRecoveryArticles,
  RECOVERY_REASON_FILTERS,
  type RecoveryKind,
  type RecoveryReasonFilter,
} from '#lib/server/article-state.ts';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const rawReason = url.searchParams.get('reason');
    let reason: RecoveryReasonFilter | undefined;
    if (rawReason !== null && rawReason.trim() !== '') {
      const normalizedReason = rawReason.trim().toLowerCase();
      if (
        !RECOVERY_REASON_FILTERS.includes(
          normalizedReason as RecoveryReasonFilter,
        )
      ) {
        return Response.json(
          {
            error: `reason must be one of: ${RECOVERY_REASON_FILTERS.join(', ')}`,
          },
          { status: 400 },
        );
      }
      reason = normalizedReason as RecoveryReasonFilter;
    }

    const rawKind = url.searchParams.get('kind');
    let kind: RecoveryKind | undefined;
    if (rawKind !== null && rawKind.trim() !== '') {
      const normalizedKind = rawKind.trim().toLowerCase();
      if (!['all', 'hidden', 'rejected'].includes(normalizedKind)) {
        return Response.json(
          { error: 'kind must be all, hidden, or rejected' },
          { status: 400 },
        );
      }
      kind = normalizedKind as RecoveryKind;
    }

    const limitValue = url.searchParams.get('limit');
    const limit =
      limitValue !== null && limitValue !== '' ? Number(limitValue) : undefined;
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || (limit as number) < 1)
    ) {
      return Response.json(
        { error: 'limit must be a positive integer' },
        { status: 400 },
      );
    }

    return Response.json(
      listRecoveryArticles({
        limit,
        cursor: url.searchParams.get('cursor') || undefined,
        feedId: url.searchParams.get('feedId') || undefined,
        q: url.searchParams.get('q') ?? undefined,
        reason,
        kind,
      }),
    );
  } catch (error: unknown) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Recovery query failed',
      },
      { status: 400 },
    );
  }
};
