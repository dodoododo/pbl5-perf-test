// Opt-in, low-load, read-only diagnostic. Never bootstrap Nest/PrismaService:
// its startup counter synchronization can write to the shared database.
import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';
import ts from 'typescript';
import { PrismaClient } from '../src/generated/prisma/client.js';

const collections = new Set([
  'Company',
  'Category',
  'JobType',
  'Skill',
  'JobPostSkill',
  'JobPost',
]);

// Parse the engine's shell representation as data, never eval query text.
// Unknown syntax fails closed. Literal values stay in memory for explain only.
export function parseAggregate(query) {
  const source = ts.createSourceFile(
    'capture.js',
    query,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (source.parseDiagnostics.length || source.statements.length !== 1)
    throw Error('Unsupported captured query');
  const statement = source.statements[0];
  if (!ts.isExpressionStatement(statement))
    throw Error('Unsupported captured query');
  const call = statement.expression;
  if (
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== 'aggregate' ||
    call.arguments.length !== 1
  )
    throw Error('Unsupported captured query');
  const target = call.expression.expression;
  if (
    !ts.isPropertyAccessExpression(target) ||
    !ts.isIdentifier(target.expression) ||
    target.expression.text !== 'db' ||
    !collections.has(target.name.text)
  )
    throw Error('Unsupported captured collection');
  function data(node) {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      if (!Number.isSafeInteger(value)) throw Error('Unsafe numeric literal');
      return value;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken
    )
      return -data(node.operand);
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(data);
    if (ts.isObjectLiteralExpression(node)) {
      const entries = node.properties.map((property) => {
        if (
          !ts.isPropertyAssignment(property) ||
          !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        )
          throw Error('Unsupported captured property');
        const key = property.name.text;
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          throw Error('Unsupported captured property');
        return [key, data(property.initializer)];
      });
      return Object.fromEntries(entries);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.arguments.length === 1
    ) {
      const name = node.expression.text;
      const value = data(node.arguments[0]);
      if (
        ['NumberLong', 'Long'].includes(name) &&
        /^-?\d+$/.test(String(value))
      )
        return { $numberLong: String(value) };
      if (name === 'NumberInt' && /^-?\d+$/.test(String(value)))
        return { $numberInt: String(value) };
      if (name === 'ObjectId' && /^[a-f\d]{24}$/i.test(value))
        return { $oid: value };
      if (name === 'ISODate' && Number.isFinite(Date.parse(value)))
        return { $date: value };
    }
    throw Error('Unsupported captured literal');
  }
  const pipeline = data(call.arguments[0]);
  assertReadOnlyPipeline(pipeline);
  return { aggregate: target.name.text, pipeline, cursor: {} };
}

export function assertReadOnlyPipeline(pipeline) {
  const allowed = new Set([
    '$match',
    '$sort',
    '$skip',
    '$limit',
    '$project',
    '$group',
    '$count',
    '$lookup',
    '$unwind',
    '$addFields',
    '$set',
    '$unset',
    '$replaceRoot',
    '$replaceWith',
  ]);
  if (!Array.isArray(pipeline)) throw Error('Unsupported pipeline');
  for (const stage of pipeline) {
    if (
      !stage ||
      Object.keys(stage).length !== 1 ||
      !allowed.has(Object.keys(stage)[0])
    )
      throw Error('Unsupported or mutating pipeline stage');
    if (stage.$lookup?.pipeline) assertReadOnlyPipeline(stage.$lookup.pipeline);
  }
}

export function queryShape(query) {
  try {
    const command = parseAggregate(query);
    const operators = {};
    const inArrayLengths = [];
    function walk(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith('$')) operators[key] = (operators[key] ?? 0) + 1;
        if (key === '$in' && Array.isArray(child)) {
          const members =
            child.length === 2 && Array.isArray(child[1]) ? child[1] : child;
          inArrayLengths.push(members.length);
        }
        walk(child);
      }
    }
    walk(command.pipeline);
    return {
      collection: command.aggregate,
      stages: command.pipeline.map((stage) => Object.keys(stage)[0]),
      operators,
      inArrayLengths,
      queryTextBytes: Buffer.byteLength(query),
      parsed: true,
    };
  } catch {
    // A failed parse must never echo text, literals, paths, or error messages.
    return { parsed: false, queryTextBytes: Buffer.byteLength(query) };
  }
}

export function explainSummary(result) {
  const root =
    result.executionStats ??
    result.stages?.find((stage) => stage.$cursor)?.$cursor?.executionStats;
  const stages = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.stage === 'string') stages.add(value.stage);
    for (const child of Object.values(value)) walk(child);
  }
  // Exclude rejected plans and server metadata/predicates from output.
  const planner =
    result.queryPlanner ??
    result.stages?.find((stage) => stage.$cursor)?.$cursor?.queryPlanner;
  walk(planner?.winningPlan);
  return {
    cursorExecutionMs: root?.executionTimeMillis ?? null,
    cursorDocsExamined: root?.totalDocsExamined ?? null,
    cursorKeysExamined: root?.totalKeysExamined ?? null,
    cursorReturned: root?.nReturned ?? null,
    winningStages: [...stages],
    aggregationStages:
      result.stages?.map((stage) => ({
        stage: Object.keys(stage).find((key) => key.startsWith('$')),
        executionTimeMillisEstimate: stage.executionTimeMillisEstimate ?? null,
        nReturned: stage.nReturned ?? null,
      })) ?? [],
  };
}

export async function createReadOnlySearchApp(distRoot, service, port = 0) {
  const [
    { NestFactory },
    { Module, ValidationPipe },
    { JobsController },
    { JobsService },
  ] = await Promise.all([
    import('@nestjs/core'),
    import('@nestjs/common'),
    import(
      pathToFileURL(resolve(distRoot, 'src/jobs/jobs.controller.js')).href
    ),
    import(pathToFileURL(resolve(distRoot, 'src/jobs/jobs.service.js')).href),
  ]);
  class ReadOnlySearchModule {}
  Module({
    controllers: [JobsController],
    providers: [{ provide: JobsService, useValue: service }],
  })(ReadOnlySearchModule);
  const app = await NestFactory.create(ReadOnlySearchModule, { logger: false });
  // The real controller has write routes too. Reject them before any guard or
  // handler can run. No AppModule, PrismaService lifecycle, workers, or tokens.
  app.use((req, res, next) => {
    if (
      req.method !== 'GET' ||
      req.path !== '/jobs/search' ||
      req.headers.authorization
    )
      return res.sendStatus(403);
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(port, '127.0.0.1');
  return app;
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      'read-only': { type: 'boolean' },
      'dist-root': { type: 'string', default: 'dist' },
      'baseline-root': { type: 'string' },
      keyword: { type: 'string', default: 'Java' },
      page: { type: 'string', default: '1' },
      limit: { type: 'string', default: '10' },
      'execution-stats': { type: 'boolean' },
      'trace-root': { type: 'string' },
      'compact-candidate': { type: 'boolean' },
      'http-smoke': { type: 'boolean' },
      serve: { type: 'boolean' },
      port: { type: 'string', default: '4405' },
      out: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node scripts/diagnose-job-search.mjs --read-only --dist-root <compiled-root> [--baseline-root <before-root>] [--trace-root <diagnostic-package-root>] [--execution-stats] [--compact-candidate] [--http-smoke] [--out <safe-summary.json>]\nUse --serve [--port 4405] for a loopback, anonymous, GET-search-only harness; no diagnostic queries run in serve mode.',
    );
    return;
  }
  if (!values['read-only'])
    throw Error('Explicit --read-only acknowledgement required');
  const page = Number(values.page);
  const limit = Number(values.limit);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw Error('Invalid pagination');
  if (
    process.env.DEBUG ||
    process.env.RUST_LOG ||
    process.env.PRISMA_LOG_QUERIES
  )
    throw Error('Disable debug logging before running sensitive diagnostics');
  const configured =
    process.env.DATABASE_URL ||
    dotenv.parse(await readFile('.env')).DATABASE_URL;
  const url = new URL(configured);
  url.searchParams.set('connectTimeoutMS', '5000');
  url.searchParams.set('socketTimeoutMS', '10000');
  const { JobsService } = await import(
    pathToFileURL(resolve(values['dist-root'], 'src/jobs/jobs.service.js')).href
  );
  let activeSpans;
  let provider;
  let instrumentation;
  if (values['trace-root']) {
    const requireTrace = createRequire(
      resolve(values['trace-root'], 'package.json'),
    );
    const { BasicTracerProvider } = requireTrace(
      '@opentelemetry/sdk-trace-base',
    );
    const { AsyncLocalStorageContextManager } = requireTrace(
      '@opentelemetry/context-async-hooks',
    );
    const { PrismaInstrumentation } = requireTrace('@prisma/instrumentation');
    provider = new BasicTracerProvider();
    provider.addSpanProcessor({
      onStart() {},
      onEnd(span) {
        // Never retain/export attributes: db.statement contains sensitive values.
        if (activeSpans)
          activeSpans.push({
            name: span.name,
            durationMs: span.duration[0] * 1000 + span.duration[1] / 1e6,
          });
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    });
    provider.register({
      contextManager: new AsyncLocalStorageContextManager().enable(),
    });
    instrumentation = new PrismaInstrumentation();
    instrumentation.setTracerProvider(provider);
    instrumentation.enable();
  }
  const prisma = new PrismaClient({
    datasourceUrl: url.href,
    log: [{ emit: 'event', level: 'query' }],
  });
  let current;
  prisma.$on('query', (event) => {
    if (current)
      current.push({
        query: event.query,
        atMs: performance.now(),
        durationMs: event.duration,
      });
  });
  const report = {
    node: process.version,
    measurements: [],
    limitations: {
      queryEventsAreNotWireRoundTrips: true,
      networkAndHydrationCannotBeIsolatedFromWallClock: true,
      explainIsSeparateExecution: true,
    },
  };
  const captures = new Map();
  async function measure(label, operation) {
    const events = [];
    const spans = [];
    activeSpans = spans;
    current = events;
    const start = performance.now();
    let result;
    try {
      result = await operation();
    } finally {
      current = undefined;
      activeSpans = undefined;
    }
    const wallMs = performance.now() - start;
    report.measurements.push({
      label,
      wallMs,
      queryEventCount: events.length,
      wireRoundTrips: null,
      ...(provider ? { spans } : {}),
      queries: events.map((event) => ({
        ...queryShape(event.query),
        emittedAfterMs: event.atMs - start,
        durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
      })),
    });
    captures.set(label, events);
    return result;
  }
  try {
    if (values.serve) {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw Error('Invalid port');
      const app = await createReadOnlySearchApp(
        values['dist-root'],
        new JobsService(prisma, {}),
        port,
      );
      console.log(
        JSON.stringify({
          event: 'read_only_search_ready',
          host: '127.0.0.1',
          port,
        }),
      );
      try {
        await new Promise((finish) => {
          process.once('SIGINT', finish);
          process.once('SIGTERM', finish);
        });
      } finally {
        await app.close();
      }
      return;
    }
    await measure('connect', () => prisma.$connect());
    for (let index = 0; index < 3; index++)
      await measure(index ? `warmPing${index}` : 'firstPing', () =>
        prisma.$runCommandRaw({ ping: 1 }),
      );
    let pageArgs;
    const client = new Proxy(prisma, {
      get(target, property) {
        if (property === 'jobPost')
          return new Proxy(target.jobPost, {
            get(delegate, method) {
              if (method === 'findMany')
                return (query) => {
                  pageArgs = query;
                  return delegate.findMany(query);
                };
              const member = delegate[method];
              return typeof member === 'function'
                ? member.bind(delegate)
                : member;
            },
          });
        return target[property];
      },
    });
    const service = new JobsService(client, {});
    let baselineService;
    const timings = {
      filterResolutionMs: 0,
      findManyMs: 0,
      countMs: 0,
      salaryFilterMs: 0,
      mappingMs: 0,
      documentsReturned: 0,
      candidateDocuments: 0,
      countExecuted: false,
    };
    const response = await measure('serviceSearch', () =>
      service.searchJobs(
        { q: values.keyword, page, limit },
        undefined,
        timings,
      ),
    );
    report.serviceTimings = timings;
    report.total = response.total;
    if (values['baseline-root']) {
      const { JobsService: BaselineService } = await import(
        pathToFileURL(
          resolve(values['baseline-root'], 'src/jobs/jobs.service.js'),
        ).href
      );
      const baselineTimings = {
        filterResolutionMs: 0,
        findManyMs: 0,
        countMs: 0,
        salaryFilterMs: 0,
        mappingMs: 0,
        documentsReturned: 0,
        candidateDocuments: 0,
        countExecuted: false,
      };
      baselineService = new BaselineService(client, {});
      const baselineResponse = await measure('baselineServiceSearch', () =>
        baselineService.searchJobs(
          { q: values.keyword, page, limit },
          undefined,
          baselineTimings,
        ),
      );
      report.baselineTimings = baselineTimings;
      report.apiEquality = {
        identicalCompleteResponse:
          JSON.stringify(response) === JSON.stringify(baselineResponse),
      };
    }
    if (!pageArgs) throw Error('No page query captured');
    const scalarSelect = Object.fromEntries(
      Object.entries(pageArgs.select).filter(([, value]) => value === true),
    );
    const without = await measure('pageWithoutRelations', () =>
      prisma.jobPost.findMany({ ...pageArgs, select: scalarSelect }),
    );
    const withRelations = await measure('pageWithRelations', () =>
      prisma.jobPost.findMany(pageArgs),
    );
    const standaloneTotal = await measure('countStandalone', () =>
      prisma.jobPost.count({ where: pageArgs.where }),
    );
    report.comparison = {
      identicalFilterOrderAndPagination: true,
      samePageIds:
        JSON.stringify(without.map((row) => row.job_post_id)) ===
        JSON.stringify(withRelations.map((row) => row.job_post_id)),
      sameServicePageIds:
        JSON.stringify(response.jobs.map((row) => row.id)) ===
        JSON.stringify(withRelations.map((row) => row.job_post_id)),
      sameTotal: response.total === standaloneTotal,
      rowsWithoutRelations: without.length,
      rowsWithRelations: withRelations.length,
      scalarResultJsonBytes: Buffer.byteLength(JSON.stringify(without)),
      relationResultJsonBytes: Buffer.byteLength(JSON.stringify(withRelations)),
    };
    if (values['http-smoke']) {
      const app = await createReadOnlySearchApp(values['dist-root'], service);
      try {
        const port = app.getHttpServer().address().port;
        const get = async (suffix) => {
          const result = await fetch(
            `http://127.0.0.1:${port}/jobs/search?${suffix}`,
            {
              signal: AbortSignal.timeout(15000),
              redirect: 'error',
            },
          );
          return { status: result.status, body: await result.json() };
        };
        const first = await measure('httpPage1', () =>
          get(
            new URLSearchParams({
              q: values.keyword,
              page: '1',
              limit: String(limit),
            }),
          ),
        );
        const second = await measure('httpPage2', () =>
          get(
            new URLSearchParams({
              q: values.keyword,
              page: '2',
              limit: String(limit),
            }),
          ),
        );
        const invalid = await measure('httpInvalidPagination', () =>
          get('limit=101'),
        );
        const beforeSecond = baselineService
          ? await measure('baselinePage2', () =>
              baselineService.searchJobs(
                { q: values.keyword, page: 2, limit },
                undefined,
              ),
            )
          : undefined;
        report.httpSmoke = {
          statuses: [first.status, second.status, invalid.status],
          page1EqualsService:
            page === 1
              ? JSON.stringify(first.body) === JSON.stringify(response)
              : null,
          page2EqualsBaseline: beforeSecond
            ? JSON.stringify(second.body) === JSON.stringify(beforeSecond)
            : null,
          identicalTotals: first.body.total === second.body.total,
          pagesDisjoint: first.body.jobs.every(
            (job) => !second.body.jobs.some((other) => job.id === other.id),
          ),
        };
      } finally {
        await app.close();
      }
    }
    if (values['compact-candidate']) {
      const { compactJobSearchMatch, searchInteger } = await import(
        pathToFileURL(
          resolve(values['dist-root'], 'src/jobs/job-search.mongo.js'),
        ).href
      );
      const match = compactJobSearchMatch(pageArgs.where);
      if (!match) throw Error('Unsupported candidate filter');
      const ids = await measure('compactPageIds', () =>
        prisma.jobPost.aggregateRaw({
          pipeline: [
            { $match: match },
            { $sort: { created_date: -1, _id: -1 } },
            { $skip: pageArgs.skip },
            { $limit: pageArgs.take },
            { $project: { _id: 1 } },
          ],
        }),
      );
      const candidate = await measure('compactPageHydration', () =>
        prisma.jobPost.findMany({
          ...pageArgs,
          where: {
            job_post_id: { in: ids.map((row) => searchInteger(row._id)) },
          },
          skip: undefined,
          take: undefined,
        }),
      );
      const counts = await measure('compactCount', () =>
        prisma.jobPost.aggregateRaw({
          pipeline: [{ $match: match }, { $count: 'total' }],
        }),
      );
      report.compactComparison = {
        identicalRawPage:
          JSON.stringify(candidate) === JSON.stringify(withRelations),
        sameTotal:
          (counts.length ? searchInteger(counts[0].total) : 0) ===
          standaloneTotal,
      };
    }
    if (values['execution-stats']) {
      report.explains = [];
      const labels = values['compact-candidate']
        ? ['compactPageIds', 'compactCount']
        : ['pageWithoutRelations', 'pageWithRelations', 'countStandalone'];
      for (const label of labels) {
        // Replay only captured, strictly parsed read commands, once each. No profiler.
        for (const event of captures.get(label)) {
          const command = parseAggregate(event.query);
          const start = performance.now();
          try {
            const explanation = await prisma.$runCommandRaw({
              explain: { ...command, maxTimeMS: 5000 },
              verbosity: 'executionStats',
              maxTimeMS: 5000,
            });
            report.explains.push({
              label,
              collection: command.aggregate,
              explainWallMs: performance.now() - start,
              ...explainSummary(explanation),
            });
          } catch (error) {
            report.explains.push({
              label,
              collection: command.aggregate,
              failed: true,
              errorType: error.name,
              errorCode: error.code ?? null,
            });
          }
        }
      }
    }
    if (values.out)
      await writeFile(values.out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
    instrumentation?.disable();
    await provider?.shutdown();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    // Prisma errors can contain the URI, predicates and returned data. Never echo them.
    console.error(
      JSON.stringify({
        event: 'job_search_diagnostic_failed',
        errorType: error.name,
        errorCode: error.code || error.errorCode || null,
      }),
    );
    process.exitCode = 1;
  });
}
