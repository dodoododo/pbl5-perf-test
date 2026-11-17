import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAggregate,
  queryShape,
  explainSummary,
  main,
  createReadOnlySearchApp,
} from './diagnose-job-search.mjs';

test('parses captured Mongo shell data without evaluating code, retaining exact Longs', () => {
  const command = parseAggregate(
    'db.JobPost.aggregate([{ $match: { _id: { $in: [NumberLong("9007199254740993")] } } }, { $limit: 10 }])',
  );
  assert.deepEqual(command.pipeline[0].$match._id.$in, [
    { $numberLong: '9007199254740993' },
  ]);
  assert.throws(() =>
    parseAggregate('db.JobPost.aggregate([{ $out: "leak" }])'),
  );
  assert.throws(() =>
    parseAggregate('db.JobPost.aggregate([{ $match: malicious() }])'),
  );
  assert.throws(() => parseAggregate('db.User.aggregate([])'));
  assert.throws(() =>
    parseAggregate(
      'db.JobPost.aggregate([{ $match: { _id: 9007199254740993 } }])',
    ),
  );
  assert.throws(() =>
    parseAggregate(
      'db.JobPost.aggregate([{ $lookup: {from:"x",pipeline:[{$merge:"x"}]} }])',
    ),
  );
});

test('structural summaries exclude all query literal values and failure text', () => {
  const summary = queryShape(
    'db.JobPost.aggregate([{ $match: { name: { $regex: "sensitive-marker", $options: "i" }, _id: { $in: [11,12] } } }])',
  );
  assert.equal(summary.parsed, true);
  assert.deepEqual(summary.stages, ['$match']);
  assert.deepEqual(summary.inArrayLengths, [2]);
  assert.ok(!JSON.stringify(summary).includes('sensitive-marker'));
  assert.deepEqual(queryShape('sensitive-marker'), {
    parsed: false,
    queryTextBytes: 16,
  });
});

test('explain summary distinguishes cursor stats and later aggregation estimates', () => {
  const result = explainSummary({
    stages: [
      {
        $cursor: {
          executionStats: { executionTimeMillis: 89, totalDocsExamined: 6361 },
          queryPlanner: {
            winningPlan: {
              stage: 'FETCH',
              filter: 'secret',
              inputStage: { stage: 'IXSCAN' },
            },
          },
        },
      },
      {
        $lookup: { from: 'secret' },
        executionTimeMillisEstimate: 200,
        nReturned: 10,
      },
    ],
    serverInfo: { host: 'secret' },
  });
  assert.equal(result.cursorExecutionMs, 89);
  assert.equal(result.aggregationStages[1].executionTimeMillisEstimate, 200);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('requires explicit opt-in before configuration, connection, or query reads', async () => {
  await assert.rejects(main([]), /--read-only/);
  await assert.rejects(main(['--read-only', '--limit', '101']), /pagination/);
});

test('read-only HTTP harness rejects write routes, tokens and invalid pagination before service calls', async () => {
  let calls = 0;
  const service = {
    searchJobs: async () => {
      calls++;
      return { jobs: [], total: 0 };
    },
  };
  const app = await createReadOnlySearchApp('dist', service);
  try {
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    for (const [path, options, status] of [
      ['/jobs', { method: 'POST' }, 403],
      ['/jobs/1', {}, 403],
      [
        '/jobs/search',
        { headers: { Authorization: 'Bearer synthetic-test-token' } },
        403,
      ],
      ['/jobs/search?limit=101', {}, 400],
    ]) {
      const response = await fetch(base + path, options);
      await response.arrayBuffer();
      assert.equal(response.status, status);
    }
    assert.equal(calls, 0);
    const response = await fetch(base + '/jobs/search?limit=10');
    await response.arrayBuffer();
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});
