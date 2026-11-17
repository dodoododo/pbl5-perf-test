# Java keyword investigation (Phase 4)

Continue with [Phase 5](job-search-phase5.md) for actual captured Prisma query shapes,
server explains, measured Before/After results and current verification instructions.

## Evidence and limits

The two measurements supplied by the user for GET
`/jobs/search?q=Java&page=1&limit=10` are individual HTTP requests, not P95 samples:

- Request 1: total 3654.64 ms; relation resolution 558.47 ms; page 3085.37 ms;
  count 2011.36 ms; mapping 1.80 ms; salary filtering did not run.
- Request 2: total 3155.60 ms; relation resolution 545.66 ms; page 2607.45 ms;
  count 1730.14 ms; mapping 0.17 ms; salary filtering did not run.

`searchJobs` (`src/jobs/jobs.service.ts:242`) awaits relation resolution before starting
page/count concurrently (`:326`). The approximate critical path is therefore
resolution + max(page, count), not resolution + page + count. Resolution + page is
3643.84 ms and 3153.11 ms respectively. Page is approximately 84.4% / 82.6% of total;
mapping is not the observed bottleneck. Count still consumes shared resources even
when it finishes before page. These are client-side Prisma operation times, including
pool wait, network transfer, engine decoding and relation loading; they do not establish
server execution time or a particular MongoDB winning plan.

Confirmed in the implementation (`src/jobs/job-search.query.ts:42`):

- Java is an unanchored, case-insensitive substring in name, title, description,
  requirements and work location. It intentionally includes JavaScript. It is also
  searched in Company.company_name, Category.name, JobType.job_type and Skill.skill_name.
- Four related-name reads run concurrently; matching skills lead to a dependent fifth
  JobPostSkill read. Matching job IDs are deduplicated before building the main OR.
  For this exact URL there are no category/location/application-filter reads. If no
  skill matches, the fifth read is skipped. Actual cardinalities are not yet known.
- Non-salary search executes the same complete JobPost filter once for page selection
  and once for an exact total. Count has no skip/limit; it must account for all matches.
- Page ordering is created_date DESC then job_post_id DESC. The page also loads Company,
  Category, JobType and up to 10 linked skills per job. `findManyMs` includes those loads.
- Salary is not involved in these two measurements. Salary searches elsewhere still
  read all otherwise-matching salary strings before choosing a page; that remains an
  explicit scaling risk, not an explanation for this request.
- Schema declarations (`prisma/schema.prisma:257`, `:263`, `:361`) describe active/date,
  FK, skill-link and proposed active/date/ID indexes. Their presence in Atlas has not
  been verified. No new index declarations were added in Phase 4.

Likely mechanisms, **not confirmed plans**: regex examination across large text fields;
a low-selectivity Java/JavaScript match; many skill-derived IDs; a blocking sort if no
usable ordered scan exists; relation-loading queries/lookup work; count and page
competing for CPU/IO/connections; cross-region RTT, shared-tier throttling or pool wait.
One indexed ID branch cannot make every regex OR branch index-efficient. An active/date
index may help ordered selection while still examining many active documents.

MongoDB documents that case-insensitive regex does not gain the expected benefit from
case-insensitive collation indexes. Do not fix this by anchoring the pattern or removing
description/requirements/related-name branches: that would change search semantics.
See [regex behavior](https://www.mongodb.com/docs/manual/reference/operator/query/regex/).

## Read-only examination pack

`scripts/job-search-java.explain.mongosh.js` defines **logical equivalent** queries for
this exact URL. It does not claim to capture Prisma's emitted wire pipelines. Prisma
may use different $expr/$regexMatch/projection/lookup placement; the helper alone cannot
prove what the original engine plan did. In particular, its page-with-relations control
loads relations after the page limit. Compare an already available actual query command
from existing Atlas diagnostics if available; do not enable profiling to obtain it.

The pack contains:

1. Related-name reads on Company, Category, JobType and Skill, projecting physical `_id`.
2. Conditional JobPostSkill lookup by skill_id, projecting job_post_id, then ID deduplication.
3. JobPost match: is_active=true AND an OR of the five regex fields and the nonempty
   company_id/category_id/job_type_id/_id membership branches resolved above.
4. Page-selection aggregation: match, sort `{created_date:-1,_id:-1}`, skip 0, limit 10,
   project response scalars and relationship keys.
5. Same match followed by `$count:'total'`, with no sort or pagination.
6. A separate page-plus-relations control with Company/Category/JobType/JobPostSkill/
   Skill lookups, preserving the 10-skill cap. Relation arrays here are diagnostic
   pipeline output, not a replacement for the application's JSON mapper.

Model IDs map to MongoDB `_id`; JobPostSkill.job_post_id and skill_id are ordinary fields.
No user credentials, connection URI, application documents or IDs are printed by resolve;
it returns cardinalities. Full explain output can contain predicate IDs and should be
redacted before external sharing.

No database operation runs when the file is loaded. It does not read .env or initiate
a connection. In an **already authenticated, approved read-only mongosh session**, after
confirming the database and investigation window, use:

```javascript
load('D:/Microsoft VS Code/Testing/pbl5-datbach/PBL5-talent-platform-it-backend/scripts/job-search-java.explain.mongosh.js');
jobSearchJava.configure({databaseName: 'YOUR_APPROVED_DB_NAME', maxTimeMS: 5000});
jobSearchJava.indexes(); // metadata only; getIndexes on the seven relevant collections
```

Index inspection itself can alternatively be done directly:

```javascript
db.JobPost.getIndexes();
db.Company.getIndexes();
db.Category.getIndexes();
db.JobType.getIndexes();
db.Skill.getIndexes();
db.JobPostSkill.getIndexes();
db.JobPostActivity.getIndexes();
```

Do not create/drop indexes, call setProfilingLevel, run db push, or run a load generator
against the shared Atlas database. The older Phase 2 runbook's profiling instructions
are exclusively for disposable local fixtures, not this investigation.

Next, one controlled diagnostic operation at a time (not a loop or load test):

```javascript
jobSearchJava.resolve();                  // up to five bounded read operations
jobSearchJava.relationPlans();            // queryPlanner, including skill links if any
jobSearchJava.pageSelectionPlan();        // queryPlanner
jobSearchJava.countPlan();                // queryPlanner
jobSearchJava.pageWithRelationsPlan();    // queryPlanner control
```

`resolve` uses sequential reads to limit concurrency, so its elapsed time is not the
application's parallel filterResolutionMs. Results describe that read window; concurrent
edits can change cardinalities later. Each operation has a 5-second server time budget
(configurable 1..10,000 ms), not a client network timeout or a budget for the whole pack.
Do not raise a timeout automatically if it expires. Explain can consume real resources
despite being read-only. After approving the individual read-execution window, request:

```javascript
jobSearchJava.relationPlans('executionStats');
jobSearchJava.pageSelectionPlan('executionStats');
jobSearchJava.countPlan('executionStats');
jobSearchJava.pageWithRelationsPlan('executionStats');
```

Record the winning index and stages, nReturned, totalKeysExamined, totalDocsExamined,
executionTimeMillis, SORT/spills and lookup scan/index information where available.
For the page, compare examined documents to the 10 returned jobs; for count, nReturned
is the single count document, not the matched-job count. Compare page-selection versus
page-with-relations cautiously: repeated executions have different cache state. Actual
Prisma commands are needed before concluding where its lookup/limit stages occur.
Avoid repeated allPlansExecution on the shared cluster.

## Safe local changes implemented

- `src/jobs/job-search.diagnostics.ts`: optional request-local `relationQueries` metadata
  records durationMs, rowsReturned and failed for each executed resolver operation.
  No raw values, IDs, returned records or error messages are retained. Disabled
  diagnostics do not create clocks/metadata. Existing aggregate fields remain intact.
- `src/jobs/job-search.query.ts`: labels the individual operations; reuses exactly equal
  trimmed keyword/category predicates within a request. It does not cache across requests
  or normalize different strings. Reused reads appear once under categoryKeyword.
- `src/jobs/jobs.service.ts`: passes timings into the resolver and skips JobPost page,
  count and salary-candidate reads when a required category resolves to an empty ID set.
  This condition is already logically impossible in the existing filter; response
  fields, zero totals, page metadata and empty facet counts are retained.
- Tests add Java/JavaScript substring + pagination coverage, equal/different category
  predicate cases, empty-category with/without salary, relation timing privacy/errors
  and request isolation. Existing 130 tests were preserved.
- `scripts/job-search-java.explain.test.mjs` validates the read-only pack against a fake
  shell: no reads on load, database guard, correct resolver predicates, shared complete
  match, deterministic page order, unpaginated count and relation-loading cap. It does
  not connect to MongoDB and does not validate a real execution plan.

Keep JOB_SEARCH_DIAGNOSTICS=true for the approved, controlled investigation. For Java,
look at the four initial reads and the skillKeyword -> skillJobs dependency; do not add
their parallel durations to reconstruct wall time. A high skillJobs row count can
explain large membership lists. New timing fields require the updated application
code to be running; no restart or deployment is performed by these changes.

These changes do **not** alter the costly Java page/count query strategy and are not
claimed to improve those observed latencies. No exact count is replaced with an estimate,
cached value or a page length.

## Further fixes requiring plan evidence and separate evaluation

- If real plans show pre-pagination lookup work, evaluate narrow ID page selection then
  page-only relation hydration. It preserves the scalar filter/order/JSON contract but
  adds a round trip and a read-consistency window; Prisma may already paginate first.
  Do not add it blindly to a high-RTT Atlas path.
- Evaluate sharing scalar match work with a page/count `$facet` only on a separate
  fixture first. Count must remain exact. Facet placement can inhibit index use; sort
  placement and the 100 MB facet limit matter. One aggregate is not automatically faster
  than two concurrent reads. See [MongoDB facet](https://www.mongodb.com/docs/manual/reference/operator/aggregation/facet/).
- Verify existing active/date/ID and skill-link indexes before proposing an index rollout.
  An ordered active-job scan may avoid a blocking sort, but cannot make every contains
  predicate selective. Do not force hints without plan and workload evidence.
- Batch identical per-request lookups as implemented; cross-request caching requires
  reliable invalidation for renames, applications and related writes to retain freshness.
  Precomputed search documents require maintained relation updates and data migration.
- If page/count server times are small but client times remain large, investigate
  application/Atlas region distance, pool wait, network and shared-cluster CPU/IO using
  existing read-only metrics. Do not increase pool concurrency on a shared tier blindly.

MongoDB `$text` indexes tokenize/stem/drop stop words and do not preserve arbitrary
substring semantics (Java versus JavaScript is a concrete counterexample). They also
do not index separate related collections as if their names were JobPost fields.
See [text index properties](https://www.mongodb.com/docs/v8.0/core/indexes/index-types/index-text/text-index-properties/).

Atlas Search is a separate design: analyzer/case handling, Lucene regex/wildcards,
substring matching across spaces and punctuation, cross-collection names, stable
date/ID ordering, exact totals and exclusion all need equivalence tests. Search indexes
are eventually consistent, which affects freshness and totals. Prefix autocomplete
or relevance-ranked token search is not a drop-in replacement. No search index or
query was created. References: [Search regex](https://www.mongodb.com/docs/search/query/operators-collectors/regex/),
[partial matching](https://www.mongodb.com/docs/search/faq/),
[Search consistency](https://www.mongodb.com/docs/search/performance/index-performance/).

## Apache JMeter Before/After plan

Use a separately approved test API/database, frozen data, identical existing indexes,
Node/Prisma versions, application region, JWT role and JMeter host. Keep this Phase 4
working-tree revision as Before/After via reviewed source snapshots; the earlier Phase 2
baseline commit is a different comparison. No JMX file or JMeter installation is supplied
by this change, and no JMeter or Atlas test was executed.

1. Define HTTP GET `/jobs/search` with q=Java, page=1, limit=10; keep-alive enabled,
   no retries, fixed request timeout and HTTP 200 + JSON assertions. Preserve IDs/order,
   exact total, response shape and page 2 non-overlap on a frozen dataset. Verify JavaScript
   still matches Java. Keep result differences separate from latency reports.
2. In controlled investigation with diagnostics enabled, perform individual requests and
   correlate their resolver/page/count timings with already approved explain operations.
3. Disable JOB_SEARCH_DIAGNOSTICS for both official comparisons. Warm up with 1 VU for
   15 seconds into a separate JTL; measure with 1 VU for 60 seconds, then evaluate errors
   before considering 5 VUs. Repeat at least three alternating Before/After runs. Do
   not start any shared-Atlas or high-load test without explicit authorization.
4. Keep a second, separately labeled GET `/jobs/1` control only if that job exists in the
   frozen fixture; do not silently mix it into a search-only acceptance workload.
5. Save raw CSV JTL (elapsed, timestamp, label, responseCode, success, thread counts,
   bytes). Report P50/P90/P95/P99, failures/requests, timeouts/429, and completed requests
   per elapsed second for each endpoint. Server timings come from the separate diagnostic
   run, not JMeter HTTP elapsed time. Do not store authorization headers or response bodies.

After creating and checking the JMX plan with those parameters, the CLI form is:

```powershell
# Template: java-search.jmx must exist and its properties must configure this exact plan.
jmeter.bat -n -t .tmp/java-search.jmx -Jusers=1 -Jduration=15 `
  -l .tmp/before-warmup.jtl -j .tmp/before-warmup.log
jmeter.bat -n -t .tmp/java-search.jmx -Jusers=1 -Jduration=60 `
  -l .tmp/before-measured.jtl -j .tmp/before-measured.log `
  -e -o .tmp/before-report
# Repeat against the reviewed After version with new output names and the same settings.
```

These are unexecuted templates, not claims that a JMX file exists or authorization to
test the shared cluster. The HTML output directory must be new/empty. Reference:
[JMeter CLI manual](https://jmeter.apache.org/usermanual/get-started.html).

## Verification

Use `npm.cmd test -- --runInBand`, `node --test scripts/job-search-java.explain.test.mjs`
and `git diff --check`. A normal `npm.cmd run build` was attempted but Windows rejected
unlink of the running API's `dist/src/generated/prisma/query_engine-windows.dll.node`.
The API was not stopped. An isolated Nest build uses ignored .tmp configuration/output,
with deleteOutDir disabled, to verify compilation without cleaning the live dist.
Verification completed: isolated Nest compilation passed; Jest passed 25/25 suites
and 140/140 tests (all 130 prior tests plus 10 new tests); the read-only explain helper's
four Node tests passed. No database performance test or real execution plan was run.
No .env values were displayed; no connection, profiler change, index mutation, data
change, load test, push, deploy or commit was performed by this investigation.
