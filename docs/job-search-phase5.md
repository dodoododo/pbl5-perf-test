# Phase 5: actual Prisma query diagnosis and bounded optimization

## Result and evidence scope

The main measured bottleneck is Prisma 6.19.3's expansion of a large skill-derived
ID membership filter into thousands of equality expressions, followed by five
sequential relation-loading queries. The logical mongosh pipelines materially
understated server execution time for the actual Prisma predicate.

Read-only measurements were collected on 2026-11-17 with Node v22.14.0 and Prisma
6.19.3. [Sanitized evidence](job-search-phase5-results.json) preserves the timings,
query shapes and explain summaries. No query literals, records, credentials,
connection hosts or JWTs are included. Full captured commands existed only in memory.

The starting working tree already contained the previous search changes and tests.
Before means that working-tree implementation, saved as an isolated compiled build;
it does not mean the Git HEAD implementation. The shared data was not frozen. These
are individual low-load observations, not percentiles, load-capacity results or a
statistically controlled benchmark. Early and late runs had different ping latency.

The first sandboxed connection failed after 30 seconds. A single network-enabled
read-only connection/ping succeeded. Subsequent operations used a plain PrismaClient,
never AppModule or PrismaService.onModuleInit: the latter can write Counter records.
No database data, indexes, profiling settings, schema or application dependencies
were changed by this phase. No push, commit, deployment or high-load run occurred.

## Before and After

One same-connection, traced comparison (After ran first, then Before):

- Complete service call: **2239.63 ms Before → 1296.94 ms After** (42.1% lower).
- Page operation including relations: **1741.10 → 700.54 ms**. After consists of
  406.38 ms native page-ID selection plus 292.97 ms unchanged Prisma hydration.
- Exact count: **1398.13 → 371.90 ms**, concurrent with page work in both versions.
- Filter resolution: **496.30 → 590.74 ms**; it was not optimized.
- Mapping: **1.38 → 3.47 ms**.
- Both returned the identical complete JSON response, including filters, field
  values, ordering, pagination and exact total **2233**.

A later untraced pair measured service **2074.99 → 1024.79 ms**, page operation
**1673.19 → 570.09 ms**, and count **1133.81 → 341.76 ms**. After selection was
336.99 ms and hydration 232.91 ms. Its complete response also matched Before.
These are two labeled pairs; their timings must not be pooled into a claimed P95.

The real Nest controller was then exercised through a temporary loopback harness:
page 1 **942.03 ms / HTTP 200**, page 2 **1047.57 ms / HTTP 200**; both page responses
matched the corresponding service/baseline responses, had the same total and no
overlapping IDs. Invalid limit=101 returned **HTTP 400 in 6.34 ms with zero DB query
events**. This harness uses the real controller and ValidationPipe but omits production
middleware, reverse proxies, background workers and authenticated traffic. These
elapsed values cover complete loopback response-body consumption. A paired Before
HTTP latency was not measured; the paired Before numbers above are service timings.

## Actual commands versus the logical explains

The resolver found 99 skills, returned 2235 JobPostSkill links, and reduced these to
1943 distinct job IDs; 16 categories also matched. Counts are metadata only.

Actual Prisma query events showed:

1. Five resolver aggregations: Company, Category, JobType, Skill and JobPostSkill.
2. A JobPost page aggregation with `$match → $sort → $skip → $limit → $project`.
   The match uses `$expr`, five `$regexMatch` predicates and **1960 `$eq` expressions**
   (including the 1943 job-ID alternatives). Captured query text was **87,548 bytes**.
3. A separate exact-count aggregation using the same match then `$group/$sum`.
4. After the JobPost page, separate Company, Category, JobType, JobPostSkill and Skill
   aggregations. There is **no `$lookup`** in this captured page query. JobPostSkill
   includes an ID sort; Prisma retains the per-job take=10 behavior during hydration.

The hand-written helper instead uses native `$regex/$in` predicates and a different
relation-loading control using `$lookup` after pagination. It is a useful logical
control, not a recording of Prisma's commands. Its 89 ms cursor figure cannot prove
the duration of its entire aggregation, and cannot describe the five separate Prisma
relation queries.

ExecutionStats of the **captured commands**, replayed once with a 5-second server
budget, measured:

- Original scalar page: **1359 ms**, 6361 documents/keys examined.
- Original page command with relation keys projected: **1364 ms**, 6361 documents/keys
  examined. Relations are separate commands and are excluded from this number.
- Original count: **1005 ms**, 6361 documents/keys examined.
- Related Company/Category/JobType queries: **0 ms** each in separate explains;
  JobPostSkill and Skill: **2 ms** each. Integer explain timing is coarse.
- Compact native page-ID selection: **51 ms**, 6361 documents/keys examined.
- Compact native exact count: **47 ms**, 6361 documents/keys examined.

Original page and compact page both retained an indexed FETCH and blocking SORT;
there was no index change. These results support optimizing predicate representation,
not blaming the number of examined documents alone or treating all `$expr` queries
as slow. Explain is a separate execution, ignores the normal plan cache, and excludes
network transfer from server execution timing. See
[MongoDB explain results](https://www.mongodb.com/docs/manual/reference/explain-results/).

## What was measured separately, and what remains unavailable

With identical where, scalar projection, ordering, skip and take, the initial pair
was **1613.35 ms without relations / 2208.98 ms with relations**; a traced repeat was
**1705.94 / 2234.43 ms**. The latter difference is **528.49 ms**, but is not a pure
hydration measurement because it compares separate executions.

The traced relation-inclusive operation provides more useful component evidence:

- Initial JobPost `prisma:engine:db_query` span: **1704.01 ms**.
- Five subsequent relation DB spans: **78.49, 112.38, 91.61, 109.92, 93.80 ms**
  (486.21 ms combined). These include driver/server/network work.
- Engine typed-result serialization/hydration: **1.80 ms**.
- Engine response JSON serialization: **0.17 ms**.
- Client argument serialization: **1.51 ms**.
- Engine connection acquisition span: **0.036 ms**.
- Scalar JSON representation: 30,011 bytes; with relations: 34,954 bytes.
  These are JSON sizes, not BSON/wire byte measurements.

Warm pings were about **76–99 ms** in the early runs and **37–40 ms** in later runs;
the traced candidate run had **84.82 / 96.02 ms** warm pings. First pings were much
slower and are labeled separately. Ping is an effective round-trip/driver proxy,
not a precise measurement of pure network time or application pool contention.
Relation-query latency is largely consistent with repeated round trips given the
very small server explains, but the exact division is not identifiable from these
separate executions. Never subtract a different run's explain time and call the
remainder measured network latency.

Observed aggregate command events per search are **12 Before / 13 After**:
5 resolver + page/count + 5 relations Before; 5 resolver + native page/count +
Prisma page hydration + 5 relations After. Thus the optimization adds one aggregate
command while making filtering much faster. Standalone findMany is 1 event without
relations and 6 with them. These counts are **lower bounds on database round trips**.
The Mongo engine's event stream does not expose every cursor getMore, handshake,
authentication or possible driver retry. For example, the 2235-link resolver had a
much longer engine operation than its single recorded DB-query span, consistent
with unobserved cursor consumption; this does not establish a getMore count.

**Measurement blocker:** exact wire-command/getMore counts and pure network versus
server/driver time require approved driver-level command monitoring, existing
correlated server telemetry, or equivalent lower-level instrumentation that the
current Prisma Mongo client does not expose. No profiler was enabled to fill that
gap. Traces measure local serialization independently, but do not isolate all
in-memory relation assembly into its own span. Tracing uses the documented
[Prisma v6 span definitions](https://www.prisma.io/docs/orm/v6/prisma-client/observability-and-logging/opentelemetry-tracing).
No exact values have been invented for the unavailable components.

## Implemented change and behavior safeguards

`job-search.mongo.ts` compiles only the allowlisted scalar filters produced by the
existing resolver. Membership stays native `$in`, job_post_id maps to physical `_id`,
and the same complete match is used for page selection and the unpaginated count.
Unknown fields, operators, modes and unsafe numeric IDs fall back to the original
Prisma query path before any raw read. The compiler accepts objects, not executable
query strings, and never accepts caller-supplied Mongo operators.

The optimized path is limited to non-salary searches whose skill branch contains
at least 1000 resolved job IDs. This is a conservative scope guard around the measured
1943-ID problem, **not an experimentally tuned crossover threshold**. Small queries
retain the old path because the extra selection round trip was not justified for them.
Salary filtering, its exact total and its existing candidate-read path remain intact.

Native selection reads only ordered page IDs, with the original created_date DESC,
_id DESC sort and unchanged skip/limit. `aggregateRaw`, rather than a raw aggregate
via `$runCommandRaw`, consumes its cursor. Prisma then hydrates just those IDs with
the exact existing SEARCH_SELECT, relation semantics, 10-skill cap, Date mapping and
API mapper. BSON Long raw IDs/totals are decoded with safe-integer validation.
See [Prisma Mongo raw APIs and cursor caveats](https://www.prisma.io/docs/orm/v6/prisma-client/using-raw-sql/raw-queries#raw-queries-with-mongodb).

Captured Prisma 6.19.3 contains wraps the supplied pattern as `.*<pattern>.*`,
with option `i`, without escaping regex metacharacters. A fixed,
nonsensitive metacharacter probe confirmed this. The compiler reproduces that exact
existing behavior; it does not introduce word/prefix/token matching, remove text or
related-name branches, escape differently, cache totals, truncate ID lists or replace
exact counts with estimates. Java still includes JavaScript.

As before, page and count are independent reads, so concurrent data edits do not
provide snapshot-consistent pagination. The optimized path additionally separates
ID selection from hydration, as the existing salary path already does; deletion or
updates during that window can affect a live page. Equivalence was verified during
the observed reads, not promised across concurrent writes. No transaction or new
consistency guarantee was introduced.

Request-local diagnostics retain findManyMs for page work, add pageSelectionMs and
hydrationMs on the compact path, and label databaseStrategy. These clocks do not
alter the HTTP response. Count remains concurrent with the complete page operation;
do not sum both to obtain request time.

The mongosh helper now deduplicates ID **values** using decimal strings, keeping the
first original BSON value. It no longer relies on Long object identity or converts
64-bit IDs to Number. The regression test covers separate equal Long objects, adjacent
values above 2^53 and mixed numeric/Long representations.

Remaining bottlenecks are resolver reads/cursor consumption (about 0.4–0.6 seconds in
the later samples), five sequential relation reads, variable network latency, and the
6361-document scan/sort. Salary searches still scale with all matching candidates.
No evidence from this phase justifies connection-pool tuning, indexes, caching,
denormalization, manual relation batching, Prisma upgrades or a different search engine.

## Reproduce diagnostics without application startup writes

The saved local Before build is `.tmp/job-search-phase4-build`; After is
`.tmp/job-search-phase5-build`. Both are ignored and are not committed artifacts.
The After isolated Nest build uses `.tmp/tsconfig.job-search-phase5.json` extending
the normal build config, with outDir `./job-search-phase5-build`, incremental=false,
and `.tmp/nest.job-search-phase4.json` with deleteOutDir=false. Compile and copy the
generated client exactly as the package postbuild does:

```powershell
node node_modules/@nestjs/cli/bin/nest.js build `
  --config .tmp/nest.job-search-phase4.json --path .tmp/tsconfig.job-search-phase5.json
node --input-type=module -e "import fs from 'node:fs'; fs.cpSync('src/generated/prisma', '.tmp/job-search-phase5-build/src/generated/prisma', {recursive:true,force:true});"
```

The existing generated Prisma 6.19.3 client was used; no db push, migrate, seed or
index synchronization is part of a build. Isolated output preserves the saved Before
build and the user's dist directory. To compare a future version, preserve its
pre-change compiled output and generated client first; Git HEAD is not this Before.

The diagnostic reads DATABASE_URL from the process or `.env` without displaying it.
Unset inherited verbose logging **in the child shell only** before running. It refuses
DEBUG, RUST_LOG or PRISMA_LOG_QUERIES because those can reveal query values.

```powershell
Remove-Item Env:DEBUG -ErrorAction SilentlyContinue
Remove-Item Env:RUST_LOG -ErrorAction SilentlyContinue
Remove-Item Env:PRISMA_LOG_QUERIES -ErrorAction SilentlyContinue
node scripts/diagnose-job-search.mjs --read-only `
  --dist-root .tmp/job-search-phase5-build `
  --baseline-root .tmp/job-search-phase4-build --http-smoke `
  --out .tmp/job-search-phase5-check.json
```

This is a bounded diagnostic, not a loop/load generator. It connects, performs one
first and two warm pings, one search per version, one identical-filter scalar page,
one relation-inclusive page, one exact count, and optional two HTTP pages plus a
baseline page-2 check. Invalid pagination makes no database call. It prints metadata
only; equality checks retain complete responses in memory. The temporary HTTP server
closes on completion and blocks every route except anonymous GET /jobs/search.
When comparing the optimized build, pass --baseline-root so the standalone comparison
uses the original complete filter instead of the optimized hydration-only ID filter.

Optional `--execution-stats` replays the strictly parsed captured standalone commands
once with maxTimeMS=5000. The parser uses the TypeScript AST; it never evaluates query
text, and rejects unknown/mutating stages. Explain failures are recorded without
retrying or printing sensitive error messages. It defaults to the standalone baseline
page/count commands; `--compact-candidate --execution-stats` instead explains the
candidate page/count. These are separate read executions, not server timings for the
earlier sample. Server budgets do not bound DNS, connection setup or the whole pack.

Tracing is opt-in, local-only, with packages installed into ignored output:

```powershell
npm.cmd install --prefix .tmp/phase5-telemetry --no-audit --no-fund --ignore-scripts `
  @prisma/instrumentation@6.19.3 @opentelemetry/sdk-trace-base@1.30.1 `
  @opentelemetry/instrumentation@0.57.2 @opentelemetry/context-async-hooks@1.30.1
# Add --trace-root .tmp/phase5-telemetry to the diagnostic command above.
```

The processor retains only span names/durations, discards attributes such as
db.statement, and sends nothing to an external telemetry collector. Nested spans
overlap and are not additive. The pinned OpenTelemetry v1 SDK emits a deprecation
notice on installation; it is diagnostic tooling only and was verified here.

## Exact Apache JMeter verification

JMeter is not installed in this environment. The supplied
[`job-search-low-load.jmx`](../scripts/job-search-low-load.jmx) was XML-validated but
**not executed in JMeter**, so its Groovy/runtime compatibility remains unverified.
Java is available. Install Apache JMeter and put jmeter.bat on PATH before these steps;
no JMeter latency or percentile results are claimed here.

1. Use the same machine, database read window/frozen approved test dataset, existing
   indexes, Node/Prisma versions and anonymous role for both versions. Keep all DB
   contents and indexes unchanged. Use the saved compiled builds; do not bootstrap
   the full application against the shared database because of counter writes.
2. In one terminal, unset DEBUG/RUST_LOG/PRISMA_LOG_QUERIES as above and start the
   Before **read-only local harness**:

   ```powershell
   node scripts/diagnose-job-search.mjs --read-only --serve `
     --dist-root .tmp/job-search-phase4-build --port 4405
   ```

   This serves only anonymous GET /jobs/search on 127.0.0.1, without AppModule,
   startup counter sync, background workers, JWTs or write endpoints. No diagnostic
   reads run in --serve mode until an HTTP request arrives. Never seed the shared DB.
3. Open the JMX in the JMeter GUI without running it. Check: exactly **one thread**,
   1-second pacing before each request, keep-alive, GET q=Java/limit=10 for page 1
   then page 2, 5-second connect/15-second response timeout, redirects disabled,
   retries disabled by the supplied properties, no response-body/header listener.
   The guard permits only 1–10 loops (two requests per loop); do not increase load.
4. Use CLI for execution. Warm up with 2 loops (4 requests), then record 10 loops
   (20 requests), with all server/JMeter verbose diagnostics disabled. If testing
   the same unchanged observed dataset, add `-JexpectedTotal=2233`; otherwise obtain
   the exact approved fixture total first. The plan always checks agreement between
   both pages even when expectedTotal is omitted.

   ```powershell
   jmeter.bat -n -t scripts/job-search-low-load.jmx `
     -q scripts/job-search-jmeter.properties -Jport=4405 -Jiterations=2 `
     -l .tmp/before-1-warmup.jtl -j .tmp/before-1-warmup.log
   jmeter.bat -n -t scripts/job-search-low-load.jmx `
     -q scripts/job-search-jmeter.properties -Jport=4405 -Jiterations=10 `
     -l .tmp/before-1.jtl -j .tmp/before-1.log -e -o .tmp/before-1-report
   ```

   Use new JTL/log names and a new/empty HTML report directory each time. Assertions
   check 200, exact response field sets, active flags, page sizes from the exact total,
   date/ID descending ordering, unique IDs and page-1/page-2 non-overlap. Assertion
   failures use a generic message; rows and IDs stay in JMeter memory. The plan stops
   the thread on an error. A stopped run is a failure even if fewer samples finished.
5. Stop the Before harness with Ctrl+C. Start the same command with
   `--dist-root .tmp/job-search-phase5-build` and run the same warmup/measurement
   commands using `after-1-*` output names. Repeat at least three alternating
   Before/After pairs using fresh names and the same parameters. These remain
   low-load checks; they are not authorization for higher concurrency.
6. Record separately for search-page-1 and search-page-2: sample count (10 per label
   per measured run), errors, 429/timeouts, P50/P90/P95/P99 and completed requests
   divided by actual elapsed seconds. With so few samples, tail percentiles are
   descriptive and cannot prove an SLO. Include complete HTTP elapsed, latency,
   connect time and byte counts from CSV; keep pacing separate from sampler elapsed.
   Server phases come from a separate diagnostic run, not JMeter HTTP elapsed.

The supplied properties disable saving query URLs, sampler data, headers and response
bodies, including on failure. Do not add View Results Tree, record tokens or mix a
job-detail control into search acceptance metrics. Authenticated seeker exclusion is
covered by unit tests; the supplied local JMeter harness deliberately rejects
Authorization headers and does not impersonate a real user. If the shared data changes
between runs, flag the comparison as affected by drift instead of changing the DB.
References: [JMeter CLI](https://jmeter.apache.org/usermanual/get-started.html),
[JSR223 assertions](https://jmeter.apache.org/usermanual/component_reference.html#JSR223_Assertion),
[result-saving configuration](https://jmeter.apache.org/usermanual/listeners.html).

## Verification

- Baseline: 25/25 Jest suites, 140/140 tests.
- After: isolated Nest compilation and generated-client packaging passed.
- Final Jest: **26/26 suites, 165/165 tests**, retaining all 140 baseline tests.
- Node diagnostic/explain/benchmark regression tests: **13/13 passed**. Benchmark
  tests use loopback fakes; they do not generate load against the shared database.
- Script syntax checks, JMX XML validation and git diff --check passed. JMeter
  execution remains unavailable because its executable is not installed.
- Live read-only comparisons matched complete responses and exact total; HTTP pages
  were disjoint and matched Before. No benchmark acceptance/SLO claim is made.
- No user changes were reverted. Pre-existing schema/index declarations were left
  untouched; no database/index synchronization command was run.
