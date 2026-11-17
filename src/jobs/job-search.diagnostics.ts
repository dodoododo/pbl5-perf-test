import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export type SearchRelationQuery =
  | 'companyKeyword'
  | 'categoryKeyword'
  | 'jobTypeKeyword'
  | 'skillKeyword'
  | 'skillJobs'
  | 'companyLocation'
  | 'categoryFilter'
  | 'appliedJobs';

export type SearchTimings = {
  filterResolutionMs: number;
  findManyMs: number;
  countMs: number;
  salaryFilterMs: number;
  mappingMs: number;
  documentsReturned: number;
  candidateDocuments: number;
  countExecuted: boolean;
  databaseStrategy?: 'prisma' | 'compactMembership';
  pageSelectionMs?: number;
  hydrationMs?: number;
  relationQueries?: Partial<
    Record<
      SearchRelationQuery,
      { durationMs: number; rowsReturned: number; failed: boolean }
    >
  >;
};

export type SearchRequest = Request & { jobSearchTimings?: SearchTimings };

export async function timeSearchOperation<T>(
  timings: SearchTimings | undefined,
  field:
    | 'filterResolutionMs'
    | 'findManyMs'
    | 'countMs'
    | 'pageSelectionMs'
    | 'hydrationMs',
  operation: () => PromiseLike<T>,
): Promise<T> {
  if (!timings) return operation();
  const start = performance.now();
  try {
    return await operation();
  } finally {
    timings[field] = (timings[field] ?? 0) + performance.now() - start;
  }
}

export async function timeSearchRelation<T>(
  timings: SearchTimings | undefined,
  name: SearchRelationQuery,
  operation: () => PromiseLike<T[]>,
): Promise<T[]> {
  if (!timings) return operation();
  const entry = { durationMs: 0, rowsReturned: 0, failed: false };
  (timings.relationQueries ??= {})[name] = entry;
  const start = performance.now();
  try {
    const rows = await operation();
    entry.rowsReturned = rows.length;
    return rows;
  } catch (error) {
    entry.failed = true;
    throw error;
  } finally {
    entry.durationMs = performance.now() - start;
  }
}

@Injectable()
export class JobSearchDiagnosticsMiddleware implements NestMiddleware {
  private readonly logger = new Logger('JobSearchDiagnostics');

  use(req: SearchRequest, res: Response, next: NextFunction) {
    if (process.env.JOB_SEARCH_DIAGNOSTICS !== 'true') return next();

    const start = performance.now();
    const timings: SearchTimings = {
      filterResolutionMs: 0,
      findManyMs: 0,
      countMs: 0,
      salaryFilterMs: 0,
      mappingMs: 0,
      documentsReturned: 0,
      candidateDocuments: 0,
      countExecuted: false,
    };
    req.jobSearchTimings = timings;
    // Never include query strings, tokens, user IDs, salaries or DB connection data.
    res.once('finish', () => {
      this.logger.log({
        event: 'job_search_timing',
        statusCode: res.statusCode,
        totalMs: performance.now() - start,
        ...timings,
      });
    });
    next();
  }
}
