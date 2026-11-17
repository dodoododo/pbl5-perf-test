# Job Search investigation and local performance runbook

The [Phase 5 investigation](job-search-phase5.md) contains subsequently collected
actual Prisma commands, read-only timings, the measured optimization and the current
low-load JMeter plan. The no-database-measurement statements below describe the older
investigation, not Phase 5.

## Status and scope

For the potentially shared Atlas database, use the [Phase 4 Java investigation](job-search-java-investigation.md)
and its read-only explain helper. The profiler/index/fixture instructions below are
for disposable local databases; they are not authorization to change Atlas settings.

This change fixes search correctness and removes repeated relation-filter joins from the
JobPost page/count queries. **No real MongoDB execution plans or latency results were
collected in this environment.** `mongosh`/`mongod` were unavailable and Docker could not
run. Application credentials were not used to connect to any database. Neither index
declarations nor benchmark instructions apply changes automatically.

NFR05-1 (P95 <= 2,000 ms at 100 concurrent users / >= 1,000 active jobs) and NFR05-2
(P95 <= 3,000 ms at 500 users / >= 3,000 active jobs) remain acceptance targets requiring
measurement. Passing unit tests does not establish either target.

The original implementation is commit `36d876bc2ab025ee86d1373e95df85e00462eaf0`.
The five Phase 1 test-maintenance edits remain in the working tree, separate from the
Phase 2 files described below.

## Confirmed findings from code

- Route: `src/jobs/jobs.controller.ts:89` delegates to `JobsService.searchJobs`.
  `src/jobs/dto/search-jobs.query.dto.ts:6` validates pagination, string filters and the
  optional boolean. `src/main.ts:39` installs validation. The optional JWT guard checks
  a token only if present (`src/jwt/optional-jwt-auth.guard.ts:7`); JWT validation returns
  its payload without a database read (`src/jwt/jwt.strategy.ts:14`).
- At the original commit, `src/jobs/jobs.service.ts:327` runs `findMany` and `count`
  concurrently with the same complex filter. `:413` filters salary **after** skip/take,
  while `:482` returns that smaller page with the unfiltered total. A matching job
  beyond the first unfiltered page can be missed, even if the reported total is large.
- The original keyword OR at `src/jobs/jobs.service.ts:259` searches name, title,
  description, requirements, work location, company name, category name, job type and
  linked skill name. Location adds an AND of work location / company city (`:308`).
  These are case-insensitive **substrings**, not token/full-text search.
- MongoDB is the connector (`prisma/schema.prisma:7`). Prisma's MongoDB insensitive
  filters use regex. Ordinary case-insensitive/collation indexes do not accelerate
  `$regex`; adding a name index alone does not solve unanchored contains searches.
  See [Prisma 6 case sensitivity](https://docs.prisma.io/docs/orm/v6/prisma-client/queries/case-sensitivity)
  and [MongoDB regex index behavior](https://www.mongodb.com/docs/manual/reference/operator/query/regex/).
- Relations were already selected in batches through Prisma, with at most 10 skills
  per returned job. There is no application loop that fetches each job's company or
  skill separately. The redundant skill ID/type fields were unused by the response
  mapper. The mapper/facet loops are bounded by the page limit of 100; their actual
  share of latency was not measured.
- `src/prisma.service.ts:44` extends **create/createMany**, not search reads. Counter
  synchronization (`:81`, `:110`) happens at startup, not for every search request.
  The client is a Nest singleton (`prisma/prisma.module.ts:5`), not created per request.
- Job Detail uses `findUnique` on the mapped MongoDB `_id` plus Company, Category,
  JobType and Employee (`src/jobs/jobs.service.ts:157`). It has no search contains
  predicates or count. Shared slowness cannot be explained solely by search regex.
- Inspection of `src`, `src/main.ts`, `src/app.module.ts`, and `package.json` found no
  throttler dependency, rate-limiting middleware, or explicit 429 response. This does
  **not** rule out a reverse proxy, hosting platform, WAF, or load generator producing
  429. Preserve response headers/body and correlate server logs to identify its origin.

## Changes and intended execution path

- `src/jobs/job-search.query.ts`: resolve company/category/type/skill matches once,
  projecting IDs only. Skill IDs resolve to job IDs through JobPostSkill; opted-in
  seeker application IDs resolve through JobPostActivity. Main JobPost filters use
  scalar IDs and retain every original keyword branch, AND/OR grouping, category and
  location condition. No active-company/category restriction was added. An applied
  job remains excluded regardless of application status. Anonymous/employee/admin
  searches ignore excludeApplied as before. No cache is introduced, so updates to
  related names become visible on the next request.
- `src/jobs/jobs.service.ts`: share a typed page projection; remove unused Skill ID/type
  reads; sort by created_date DESC, job_post_id DESC for deterministic ties. Non-salary
  searches retain parallel exact count/page reads. Salary searches read only matching
  IDs + salary strings, apply the **existing parser and range-containment semantics**,
  compute total, slice the matching IDs, and hydrate only that page. An empty matching
  page skips hydration; salary searches need no separate database count. Facets remain
  page-scoped and the public JSON fields are unchanged.
- `src/jobs/job-search.diagnostics.ts`: optional HTTP middleware and operation timing
  helper. `src/jobs/jobs.module.ts` registers middleware only for GET jobs/search;
  `src/jobs/jobs.controller.ts` passes its request-local timing object to the service.
  No shared mutable request metrics or query/credential logging is used.
- `prisma/schema.prisma`: two additive index declarations, detailed below. No field
  migration, salary backfill, schema push, index creation or index removal was run.
- `src/jobs/jobs.service.spec.ts`: regression cases for every keyword source, combined
  filters, salary parsing/containment/totals/page boundaries, empty results, tied-date
  ordering, authentication-specific exclusion, public mapping/facets and timings.
  The repository fake interprets scalar filters and cannot process relation predicates.
- `src/jobs/jobs.controller.spec.ts`: real Nest HTTP routing/DTO validation tests with
  a mocked service; diagnostics on/off, rejected requests, and metadata-only logging.
- `scripts/benchmark-jobs-search.mjs`: deterministic local fixture seeder, read-only
  controller/service HTTP harness, and a repeatable concurrent load generator. It
  supports compiled original or optimized code through --dist-root. It never loads
  .env, uses BENCH_DATABASE_URL explicitly and rejects remote database/server URLs.
  Seeding refuses a nonempty database and never deletes data. The harness uses a
  fixed synthetic seeker JWT, no background services or Prisma startup counter writes.
- `scripts/benchmark-jobs-search.test.mjs`: Node smoke tests for benchmark metrics/429
  handling, remote-database rejection, and a compiled harness boot/validation request
  that requires no database connection. These are separate from the Jest unit suite.
- This runbook records evidence, risks and exact reproduction steps. No changes were
  made to SearchJobsQueryDto, PrismaService, Job Detail business logic or job writes.

## Diagnostics

Set `JOB_SEARCH_DIAGNOSTICS=true` before starting the application. Any other value
disables collection; the disabled HTTP path checks one environment variable and does
not create timers/listeners/metric objects. One metadata-only record is emitted when
the response finishes:

- `totalMs`: middleware entry to HTTP finish, including guards, validation, service,
  mapping and serialization. It excludes ingress/proxy delay before middleware and
  client network transfer after server finish; the benchmark measures client duration.
- `filterResolutionMs`: the full related-ID resolution wall time, including all those
  lookups. They are intentionally not hidden in mapping time.
- `findManyMs`: sum of JobPost findMany durations; salary requests have candidate and
  optional hydration reads. Non-salary requests have one page read.
- `countMs`, `countExecuted`: count duration and whether a database count ran. A salary
  total is computed from the matched candidate list, so countExecuted is false.
- `salaryFilterMs`, `mappingMs`: salary parsing/filter/page selection and response/
  facet mapping, respectively. `documentsReturned` counts hydrated response jobs;
  `candidateDocuments` counts the narrow salary candidates read (zero on other paths).
- `statusCode`: distinguishes successful, validation and error responses. A zero for
  an operation that did not run is not a measured zero-latency database operation.

Parallel count/find timings overlap and must not be summed to estimate total latency.
Completed operation timings are retained even if a database operation rejects. Aborted
responses that never emit finish are not logged. Disable diagnostics for acceptance
load runs; console logging itself adds overhead. Use a short separate diagnostic run.

## Index review (manual, local first)

New declarations at `prisma/schema.prisma:263` and `:363` correspond to:

```javascript
db.JobPost.createIndex(
  { is_active: 1, created_date: -1, _id: -1 },
  { name: 'jobs_search_active_created_id' }
);
db.JobPostSkill.createIndex(
  { skill_id: 1, job_post_id: 1 },
  { name: 'jobs_search_skill_job' }
);
```

The first supports active-job ordering including the new ID tie-breaker. The second
is a candidate covering reverse skill lookup. Plans must confirm actual use. Existing
indexes are retained; review write/storage overhead and redundancy after measurement.
No new salary index is useful while salaries remain heterogeneous strings and are
parsed in application code. Category/company/type FK indexes already exist; longer
FK + active + date + ID indexes should be evaluated only against representative plans.
Do not create collation/text indexes expecting them to preserve arbitrary substring
semantics and accelerate all current OR branches.

Never run an automatic production `prisma db push` for this investigation. An index
rollout requires review of deployed getIndexes(), plans, capacity and the two explicit
createIndex operations above; deploying code alone does not install these indexes.

## Exact MongoDB plan and profiler procedure

Use a disposable local replica set, **not the application/production database**.
If only Atlas access is available, obtain an approved diagnostic workflow separately;
the following profiler changes are for the disposable local database only.

1. In mongosh connected to the fixture, confirm `db.getName()` begins with
   job_search_bench_. Inspect `db.JobPost.getIndexes()`, `db.JobPostSkill.getIndexes()`,
   `db.JobPostActivity.getIndexes()`, and corresponding relation collections. Prisma
   declarations do not prove those indexes exist in a deployed database.
2. With no load test running, capture one scenario at a time, in the same mongosh session:

```javascript
if (!db.getName().startsWith('job_search_bench_')) throw Error('Local fixture only');
const previous = db.getProfilingStatus();
if (previous.was !== 0 || previous.filter) throw Error('Use a fresh unprofiled fixture');
const started = new Date();
db.setProfilingLevel(2);
// Now issue ONE HTTP request from another terminal, for example:
// curl.exe "http://127.0.0.1:4400/jobs/search?q=react&location=H%C3%A0%20N%E1%BB%99i"
// Then return here immediately:
db.setProfilingLevel(0);
const reads = db.system.profile.find({
  ts: { $gte: started }, 'command.aggregate': { $exists: true }
}).sort({ ts: 1 }).toArray();
for (const entry of reads) {
  const command = {
    aggregate: entry.command.aggregate,
    pipeline: entry.command.pipeline,
    cursor: {}
  };
  for (const key of ['collation', 'let', 'allowDiskUse']) {
    if (entry.command[key] !== undefined) command[key] = entry.command[key];
  }
  print(EJSON.stringify({ collection: command.aggregate, millis: entry.millis,
    plan: db.runCommand({ explain: command, verbosity: 'executionStats' }) }, null, 2));
}
```

This replays **the actual Prisma-generated pipelines**, including relation loading
and count pipelines, rather than guessing how Prisma translates a where object.
Prisma 6 MongoDB reads use aggregation; if a different client emits find commands,
capture `command.find` too and use
`db.runCommand({explain: {find: entry.command.find, filter: entry.command.filter || {},
projection: entry.command.projection || {}, sort: entry.command.sort || {}},
verbosity: 'executionStats'})`, copying skip/limit if present.

As a separate scalar baseline, compare these exact operations before/after the new index:

```javascript
db.JobPost.explain('executionStats')
  .find({ is_active: true }, { _id: 1, salary: 1 })
  .sort({ created_date: -1, _id: -1 }).skip(0).limit(20);
db.JobPost.explain('executionStats')
  .aggregate([{ $match: { is_active: true } }, { $count: 'total' }]);
db.JobPost.explain('executionStats').find({ _id: 1 });
db.JobPostSkill.explain('executionStats')
  .find({ skill_id: { $in: [1] } }, { _id: 0, job_post_id: 1 });
```

Record winning plans, IXSCAN/COLLSCAN, blocking SORT, keys/documents examined,
executionTimeMillis, nReturned, lookup indexes/scans and spills. Compare ratios to
matched jobs, not only returned page length. Repeat for keyword-only, combined,
category, salary, excludeApplied, no-match and detail. Explain executionTimeMillis is
not HTTP P95. Profiler changes add overhead and are not part of acceptance load runs.
References: [MongoDB explain](https://www.mongodb.com/docs/manual/reference/method/db.collection.explain/),
[explain fields](https://www.mongodb.com/docs/manual/reference/explain-results/),
[database profiler](https://www.mongodb.com/docs/manual/tutorial/manage-the-database-profiler/).

## Repeatable local benchmark (PowerShell)

Prerequisites: Node/npm dependencies installed, Docker with a MongoDB replica set, or
an equivalent local mongod + mongosh. No application credentials are needed. These
commands are instructions for the reviewer; no MongoDB container was started here.

```powershell
docker run --detach --name job-search-mongo --publish 127.0.0.1:27017:27017 mongo:7.0 --replSet rs0 --bind_ip_all
'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})' | docker exec -i job-search-mongo mongosh --quiet
# Wait for rs.status().myState == 1 before seeding.
npm.cmd run build
$env:BENCH_DATABASE_URL = 'mongodb://127.0.0.1:27017/job_search_bench_1000?replicaSet=rs0&directConnection=true'
node scripts/benchmark-jobs-search.mjs seed --jobs 1000
```

Before the first baseline run, install the **existing** search-relevant indexes in that
fixture using `docker exec -it job-search-mongo mongosh job_search_bench_1000`:

```javascript
db.JobPost.createIndex({is_active:1, created_date:-1});
db.JobPost.createIndex({created_date:-1});
db.JobPost.createIndex({company_id:1, is_active:1});
db.JobPost.createIndex({category_id:1, is_active:1});
db.JobPost.createIndex({job_type_id:1, is_active:1});
db.JobPost.createIndex({employee_id:1});
db.JobPostSkill.createIndex({job_post_id:1, skill_id:1}, {unique:true});
db.JobPostSkill.createIndex({skill_id:1});
db.JobPostActivity.createIndex({seeker_id:1, job_post_id:1}, {unique:true});
db.JobPostActivity.createIndex({job_post_id:1});
db.JobPostActivity.createIndex({seeker_id:1});
db.Company.createIndex({is_active:1, created_date:-1});
db.Company.createIndex({company_name:1});
db.Company.createIndex({city:1});
db.Category.createIndex({is_active:1, name:1});
db.Skill.createIndex({skill_name:1}, {unique:true});
```

MongoDB already creates each collection's `_id` index. These cover the existing indexes
relevant to the searched/read fields; unrelated write/status indexes do not change
this fixed, read-only workload. Keep index sets identical for the first code comparison.

Prepare the unoptimized commit once (does not alter the active working tree):

```powershell
git worktree add --detach .tmp/job-search-baseline 36d876bc2ab025ee86d1373e95df85e00462eaf0
Push-Location .tmp/job-search-baseline
npm.cmd ci
npm.cmd run build
Pop-Location
```

Start **one** server at a time in a separate terminal with the same BENCH_DATABASE_URL:

```powershell
# Original; the harness imports the old compiled controller and service.
node scripts/benchmark-jobs-search.mjs serve --dist-root .tmp/job-search-baseline/dist
# Stop with Ctrl+C, then run the optimized code on the same fixture and port:
node scripts/benchmark-jobs-search.mjs serve --dist-root dist
```

In the load-generator terminal, measure each server with the identical command, changing
only the label/output path. Keep JOB_SEARCH_DIAGNOSTICS disabled for both:

```powershell
node scripts/benchmark-jobs-search.mjs run --concurrency 100 --minimum-jobs 1000 --warmup 15 --seconds 60 --label original --out .tmp/search-original-100.json
node scripts/benchmark-jobs-search.mjs run --concurrency 100 --minimum-jobs 1000 --warmup 15 --seconds 60 --label optimized --out .tmp/search-optimized-100.json
```

Then install the **two new indexes** listed above in the same disposable fixture and
repeat **both** implementations. This separates code effects from index effects.
For NFR05-2, seed a fresh `job_search_bench_3000` database with `seed --jobs 3000`, install
the same index sets, restart the selected server against it, and use
`run --concurrency 500 --minimum-jobs 3000 --warmup 15 --seconds 60`.

The generator uses a closed-loop model: each of 100/500 users issues one request at a
time without think time. Nine search scenarios and one Job Detail control are mixed
equally by request count. Warmup samples are discarded; full response bodies are read.
Outputs include P50/P95/P99 for each scenario and all search requests, status counts
(including 429), timeout/network failures, throughput and dataset/concurrency metadata.
Failures count against acceptance rather than disappearing from the percentile sample.
Report at least three alternating original/optimized runs; compare per-scenario P95,
errors, counts and throughput, not just the mixed aggregate. Save machine CPU/RAM,
MongoDB image/version, index list, fixture size, code revision and logging settings
alongside reports. Synthetic salary results differ on the original because of its bug.

The isolated harness is for controlled code/database comparison. It omits production
workers, Prisma startup synchronization, TLS, proxies and hosting limits; NFR acceptance
also needs the full app and representative deployment/data/load distribution. Do not
interpret its acceptance booleans as production certification. The load generator and
server can contend for the same host CPU; use identical machines/settings across runs.

## Remaining risks and next measurement decisions

- Relation resolution introduces up to eight reads (keyword four + one skill-link read,
  location, category and applications), with the skill-link read dependent on skill IDs.
  It avoids repeating per-JobPost relation filters in count/page queries, but added
  round trips and concurrent load can outweigh that saving. This is a structural
  optimization hypothesis until benchmarked; no latency improvement is claimed.
- Unanchored regex still scans strings, including descriptions. Related collections
  are scanned for substrings too. Large ID/notIn lists consume memory and query bytes;
  at much larger scale a denormalized search document / dedicated search engine needs
  separate design and semantic equivalence tests. Text search is not a drop-in substitute.
- Legacy salary correctness requires O(number of non-salary matches) narrow candidate
  reads/parses for each salary request, then at most one page hydration. This is deliberately
  explicit, not silently capped. Numeric salary fields + reviewed backfill/write-path
  maintenance would allow database range filtering, but that migration is outside this
  change. Measure memory/GC under 500 users as well as latency.
- Separate related-ID, page and count operations do not provide a cross-collection
  snapshot. Concurrent renames/applications/job edits can produce transient mismatches;
  salary totals describe the candidate-read snapshot and a later delete could shorten
  hydration. The original count/page were also separate reads. No transactions, result
  cache or consistency guarantee was added.
- Offset pagination still costs more on deep pages. A cursor API would need a separately
  reviewed contract change. ID tie-breaking changes only formerly unspecified ordering
  of equal creation timestamps; page facets remain page-specific.
- Job Detail slowness, connection pool wait, cross-region RTT, Atlas tier CPU/IO and
  network contention remain hypotheses. Compare low-load detail vs browse, then shared
  load with profiler/Atlas metrics and client RTT. If detail remains slow at one user,
  inspect its `_id`/lookup plan and network before attributing it to search. The local
  benchmark cannot reproduce or identify a production proxy's 429 responses.

## Local verification

Run after changes:

```powershell
npm.cmd run build
npm.cmd test -- --runInBand
node --test scripts/benchmark-jobs-search.test.mjs
git diff --check
```

The benchmark smoke tests use a synthetic HTTP server and a validation-only Nest
request; their timings are **not database performance evidence**. Full fixture seeding,
MongoDB plans and 100/500-user runs remain to be executed on a local MongoDB replica set.

Verified on 2026-11-16: build passed; Jest passed 24/24 suites and 130/130 tests
(23 new search/HTTP regression tests); Node benchmark smoke tests passed 3/3;
`git diff --check` passed. No remaining test failures. No deployment, push, database
seeding, profiling, schema push or index creation was performed.
