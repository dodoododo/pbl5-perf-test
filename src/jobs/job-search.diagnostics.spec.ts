import {
  timeSearchRelation,
  type SearchTimings,
} from './job-search.diagnostics.js';

const timings = (): SearchTimings => ({
  filterResolutionMs: 0,
  findManyMs: 0,
  countMs: 0,
  salaryFilterMs: 0,
  mappingMs: 0,
  documentsReturned: 0,
  candidateDocuments: 0,
  countExecuted: false,
});

describe('relation query diagnostics', () => {
  it('passes through query results when diagnostics are disabled', async () => {
    const rows = [{ skill_id: 1 }];
    const operation = jest.fn().mockResolvedValue(rows);
    expect(await timeSearchRelation(undefined, 'skillKeyword', operation)).toBe(
      rows,
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('records row count and duration without keeping returned data', async () => {
    const metrics = timings();
    await timeSearchRelation(metrics, 'skillKeyword', async () => [
      { privateValue: 'private-result' },
    ]);
    expect(metrics.relationQueries?.skillKeyword).toEqual({
      rowsReturned: 1,
      durationMs: expect.any(Number),
      failed: false,
    });
    expect(JSON.stringify(metrics)).not.toContain('private-result');
  });

  it('records a failed operation and rethrows the same error without logging its message', async () => {
    const metrics = timings();
    const failure = new Error('private connection details');
    await expect(
      timeSearchRelation(metrics, 'companyKeyword', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(metrics.relationQueries?.companyKeyword).toEqual({
      rowsReturned: 0,
      durationMs: expect.any(Number),
      failed: true,
    });
    expect(JSON.stringify(metrics)).not.toContain('private connection details');
  });

  it('keeps concurrent request metrics independent', async () => {
    const first = timings();
    const second = timings();
    await Promise.all([
      timeSearchRelation(first, 'companyKeyword', async () => [1]),
      timeSearchRelation(second, 'companyKeyword', async () => [1, 2]),
    ]);
    expect(first.relationQueries?.companyKeyword?.rowsReturned).toBe(1);
    expect(second.relationQueries?.companyKeyword?.rowsReturned).toBe(2);
  });
});
