import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(
  new URL('./job-search-java.explain.mongosh.js', import.meta.url),
  'utf8',
);
const plain = (value) => JSON.parse(JSON.stringify(value));

function shell(overrides = {}) {
  const calls = [];
  const fixtures = {
    Company: [{ _id: 11 }],
    Category: [],
    JobType: [{ _id: 31 }],
    Skill: [{ _id: 41 }, { _id: 42 }],
    JobPostSkill: [
      { job_post_id: 71 },
      { job_post_id: 72 },
      { job_post_id: 71 },
    ],
    ...overrides,
  };
  const db = {
    getName: () => 'approved_test_db',
    getCollection(collection) {
      return {
        getIndexes() {
          calls.push({ type: 'indexes', collection });
          return [{ name: '_id_' }];
        },
        find(filter, projection) {
          const record = { type: 'find', collection, filter, projection };
          return {
            maxTimeMS(budget) {
              record.maxTimeMS = budget;
              return this;
            },
            toArray() {
              calls.push(record);
              return fixtures[collection] ?? [];
            },
            explain(verbosity) {
              calls.push({ ...record, verbosity });
              return record;
            },
          };
        },
        explain(verbosity) {
          return {
            aggregate(pipeline, options) {
              const record = {
                type: 'aggregate',
                collection,
                pipeline,
                options,
                verbosity,
              };
              calls.push(record);
              return record;
            },
          };
        },
      };
    },
  };
  const context = vm.createContext({ db });
  vm.runInContext(source, context);
  return { api: context.jobSearchJava, calls };
}

test('loading makes no DB calls and requires explicit matching database configuration', () => {
  const { api, calls } = shell();
  assert.equal(calls.length, 0);
  assert.throws(() => api.indexes(), /Configure/);
  assert.throws(
    () => api.configure({ databaseName: 'another_db' }),
    /does not match/,
  );
  assert.throws(
    () => api.configure({ databaseName: 'approved_test_db', maxTimeMS: 20000 }),
    /maxTimeMS/,
  );
  assert.equal(calls.length, 0);
});

test('resolves all related Java predicates and deduplicates skill job IDs without printing records', () => {
  const { api, calls } = shell();
  api.configure({ databaseName: 'approved_test_db' });
  assert.deepEqual(plain(api.resolve()), {
    companies: 1,
    categories: 0,
    types: 1,
    skills: 2,
    jobs: 2,
  });
  assert.deepEqual(
    calls.map((call) => call.collection),
    ['Company', 'Category', 'JobType', 'Skill', 'JobPostSkill'],
  );
  for (const call of calls) assert.equal(call.maxTimeMS, 5000);
  assert.deepEqual(plain(calls[0].filter), {
    company_name: { $regex: 'Java', $options: 'i' },
  });
  assert.deepEqual(plain(calls[4].filter), { skill_id: { $in: [41, 42] } });
});

test('page and count share the complete match; only page sorts and paginates', () => {
  const { api } = shell();
  api.configure({ databaseName: 'approved_test_db' });
  assert.throws(() => api.countPlan(), /resolve/);
  api.resolve();
  const page = plain(api.pageSelectionPlan('executionStats'));
  const count = plain(api.countPlan());
  assert.deepEqual(page.pipeline[0], count.pipeline[0]);
  assert.equal(page.pipeline[0].$match.is_active, true);
  const or = page.pipeline[0].$match.$and[0].$or;
  assert.deepEqual(
    or.slice(0, 5).map((item) => Object.keys(item)[0]),
    [
      'name',
      'job_title',
      'job_description',
      'candidate_requirements',
      'work_location',
    ],
  );
  assert.deepEqual(or.at(-1), { _id: { $in: [71, 72] } });
  assert.deepEqual(page.pipeline.slice(1, 4), [
    { $sort: { created_date: -1, _id: -1 } },
    { $skip: 0 },
    { $limit: 10 },
  ]);
  assert.deepEqual(count.pipeline[1], { $count: 'total' });
  assert.equal(count.pipeline.length, 2);
  assert.equal(count.verbosity, 'queryPlanner');
  assert.equal(page.verbosity, 'executionStats');
});

test('deduplicates distinct BSON Long objects by exact value and keeps BSON values', () => {
  class Long {
    constructor(value) {
      this.value = value;
    }
    toString() {
      return this.value;
    }
    valueOf() {
      throw Error('Must not coerce a BSON Long to Number');
    }
  }
  const first = new Long('9007199254740992');
  const next = new Long('9007199254740993');
  const { api } = shell({
    JobPostSkill: [
      { job_post_id: first },
      { job_post_id: new Long('9007199254740992') },
      { job_post_id: next },
      { job_post_id: new Long('9007199254740993') },
      { job_post_id: new Long('71') },
      { job_post_id: 71 },
    ],
  });
  api.configure({ databaseName: 'approved_test_db' });
  assert.equal(api.resolve().jobs, 3);
  const ids = api.pageSelectionPlan().pipeline[0].$match.$and[0].$or.at(-1)
    ._id.$in;
  assert.equal(ids[0], first);
  assert.equal(ids[1], next);
  assert.deepEqual(
    Array.from(ids, (value) => value.toString()),
    ['9007199254740992', '9007199254740993', '71'],
  );
});

test('relation-loading control limits the page first and retains all four relation loads', () => {
  const { api } = shell();
  api.configure({ databaseName: 'approved_test_db' });
  api.resolve();
  const plan = plain(api.pageWithRelationsPlan());
  const lookups = plan.pipeline
    .filter((stage) => stage.$lookup)
    .map((stage) => stage.$lookup);
  assert.deepEqual(
    lookups.map((lookup) => lookup.from),
    ['Company', 'Category', 'JobType', 'JobPostSkill'],
  );
  assert.deepEqual(plan.pipeline[3], { $limit: 10 });
  assert.deepEqual(lookups[3].pipeline[0], { $limit: 10 });
  assert.equal(lookups[3].pipeline[2].$lookup.from, 'Skill');
  assert.throws(() => api.countPlan('allPlansExecution'), /queryPlanner/);
});
