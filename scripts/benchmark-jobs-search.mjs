import 'reflect-metadata';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PrismaClient } from '../src/generated/prisma/client.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    jobs: { type: 'string', default: '1000' },
    'dist-root': { type: 'string', default: 'dist' },
    port: { type: 'string', default: '4400' },
    url: { type: 'string', default: 'http://127.0.0.1:4400' },
    concurrency: { type: 'string', default: '100' },
    seconds: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '10' },
    'timeout-ms': { type: 'string', default: '10000' },
    'minimum-jobs': { type: 'string', default: '1000' },
    label: { type: 'string', default: 'local' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
});

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const benchSecret = 'local-job-search-benchmark-only';

function integer(name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(values[name]);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid --${name}`);
  return value;
}

function databaseUrl() {
  // Deliberately never load .env or fall back to the application's DATABASE_URL.
  const url = new URL(process.env.BENCH_DATABASE_URL || '');
  if (
    url.protocol !== 'mongodb:' ||
    !localHosts.has(url.hostname) ||
    !/^\/job_search_bench_[a-z0-9_]+$/.test(url.pathname) ||
    url.username ||
    url.password ||
    url.searchParams.has('tls') ||
    url.searchParams.has('ssl')
  )
    throw new Error(
      'BENCH_DATABASE_URL must name an unauthenticated loopback job_search_bench_* database',
    );
  return url.href;
}

async function seed() {
  const count = integer('jobs', 1, 100_000);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl() });
  try {
    const collections = await prisma.$runCommandRaw({
      listCollections: 1,
      nameOnly: true,
    });
    if (collections.cursor.firstBatch.length)
      throw new Error(
        'Fixture database must be empty; choose a new job_search_bench_* name. No data was removed.',
      );
    const date = new Date('2026-01-01T00:00:00Z');
    await prisma.company.createMany({
      data: Array.from({ length: 20 }, (_, index) => ({
        company_id: index + 1,
        company_name: index % 3 ? `Company ${index}` : `React Labs ${index}`,
        city: index % 2 ? 'Hà Nội' : 'Đà Nẵng',
        is_active: true,
        created_date: date,
      })),
    });
    await prisma.category.createMany({
      data: [
        { category_id: 1, name: 'Web' },
        { category_id: 2, name: 'Data' },
      ],
    });
    await prisma.jobType.createMany({
      data: [
        { job_type_id: 1, job_type: 'Full-time' },
        { job_type_id: 2, job_type: 'Contract' },
      ],
    });
    await prisma.user.createMany({
      data: [
        {
          user_id: 1,
          email: 'employee@benchmark.invalid',
          password: 'unused',
          role: 'EMPLOYEE',
        },
        {
          user_id: 42,
          email: 'seeker@benchmark.invalid',
          password: 'unused',
          role: 'SEEKER',
        },
      ],
    });
    await prisma.employee.create({
      data: { employee_id: 1, company_id: 1, role: 'Recruiter' },
    });
    await prisma.seeker.create({ data: { seeker_id: 42, updated_date: date } });
    await prisma.skill.createMany({
      data: [
        {
          skill_id: 1,
          skill_name: 'React',
          skill_type: 'TECHNICAL',
          updated_date: date,
        },
        {
          skill_id: 2,
          skill_name: 'Python',
          skill_type: 'TECHNICAL',
          updated_date: date,
        },
      ],
    });
    // Fixed data, dates and IDs make both implementations see exactly the same fixture.
    for (let offset = 0; offset < count; offset += 500) {
      const rows = Array.from(
        { length: Math.min(500, count - offset) },
        (_, index) => {
          const id = offset + index + 1;
          return {
            job_post_id: id,
            employee_id: 1,
            company_id: (id % 20) + 1,
            category_id: (id % 2) + 1,
            job_type_id: (id % 2) + 1,
            name: id % 3 ? `Backend ${id}` : `React Developer ${id}`,
            job_title: id % 3 ? `Backend ${id}` : `React Developer ${id}`,
            job_description: `Build APIs and products. ${'Representative description. '.repeat(40)}`,
            candidate_requirements:
              id % 4 ? 'TypeScript and APIs' : 'React and Python',
            work_location: id % 5 ? null : 'Remote Hà Nội',
            salary:
              id % 10 === 0
                ? 'Negotiable'
                : `${((id % 4) + 1) * 10}M-${((id % 4) + 2) * 10}M`,
            created_date: new Date(date.getTime() + Math.floor(id / 10) * 1000),
            updated_date: date,
            is_active: true,
          };
        },
      );
      await prisma.jobPost.createMany({ data: rows });
      await prisma.jobPostSkill.createMany({
        data: rows.map((row) => ({
          id: row.job_post_id,
          job_post_id: row.job_post_id,
          skill_id: (row.job_post_id % 2) + 1,
        })),
      });
      const applications = rows
        .filter((row) => row.job_post_id % 7 === 0)
        .map((row) => ({
          application_id: row.job_post_id,
          seeker_id: 42,
          job_post_id: row.job_post_id,
          apply_date: date,
          last_updated: date,
          status: 'PENDING',
        }));
      if (applications.length)
        await prisma.jobPostActivity.createMany({ data: applications });
    }
    console.log(JSON.stringify({ event: 'fixture_seeded', activeJobs: count }));
  } finally {
    await prisma.$disconnect();
  }
}

async function serve() {
  const datasourceUrl = databaseUrl();
  process.env.ACCESS_TOKEN_SECRET = benchSecret;
  const load = (file) =>
    import(pathToFileURL(resolve(values['dist-root'], 'src', file)).href);
  const [
    { NestFactory },
    { Module, Controller, Get, ValidationPipe },
    { PassportModule },
    { JobsController },
    { JobsService },
    { JwtStrategy },
  ] = await Promise.all([
    import('@nestjs/core'),
    import('@nestjs/common'),
    import('@nestjs/passport'),
    load('jobs/jobs.controller.js'),
    load('jobs/jobs.service.js'),
    load('jwt/jwt.strategy.js'),
  ]);
  const prisma = new PrismaClient({ datasourceUrl });
  class InfoController {
    async info() {
      return {
        fixture: 'job-search-v1',
        activeJobs: await prisma.jobPost.count({ where: { is_active: true } }),
      };
    }
  }
  Controller('__benchmark')(InfoController);
  Get('info')(
    InfoController.prototype,
    'info',
    Object.getOwnPropertyDescriptor(InfoController.prototype, 'info'),
  );
  class BenchmarkModule {}
  Module({
    imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
    controllers: [JobsController, InfoController],
    providers: [
      JwtStrategy,
      { provide: JobsService, useValue: new JobsService(prisma, {}) },
    ],
  })(BenchmarkModule);
  const app = await NestFactory.create(BenchmarkModule, {
    logger:
      process.env.JOB_SEARCH_DIAGNOSTICS === 'true'
        ? ['log', 'warn', 'error']
        : false,
  });
  const diagnosticsPath = resolve(
    values['dist-root'],
    'src/jobs/job-search.diagnostics.js',
  );
  if (
    await access(diagnosticsPath).then(
      () => true,
      () => false,
    )
  ) {
    const { JobSearchDiagnosticsMiddleware } = await import(
      pathToFileURL(diagnosticsPath).href
    );
    const middleware = new JobSearchDiagnosticsMiddleware();
    app.use('/jobs/search', middleware.use.bind(middleware));
  }
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(integer('port', 1024, 65535), '127.0.0.1');
  console.log(
    'Local read-only search harness ready. No background workers or startup counter writes.',
  );
  const close = async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

const scenarios = [
  ['browse', '/jobs/search?limit=20'],
  ['keyword', '/jobs/search?q=react&limit=20'],
  [
    'keyword-location',
    '/jobs/search?q=react&location=H%C3%A0%20N%E1%BB%99i&limit=20',
  ],
  ['category', '/jobs/search?category=web&limit=20'],
  ['salary', '/jobs/search?salaryMin=10M&salaryMax=30M&limit=20'],
  ['page-2', '/jobs/search?q=react&page=2&limit=20'],
  ['exclude-applied', '/jobs/search?q=react&excludeApplied=true&limit=20'],
  [
    'combined',
    '/jobs/search?q=react&category=web&location=H%C3%A0%20N%E1%BB%99i&salaryMin=10M&salaryMax=30M&excludeApplied=true',
  ],
  ['no-match', '/jobs/search?q=unmatched-fixture-token'],
  ['detail-control', '/jobs/1'],
];

function summary(samples) {
  const latencies = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const percentile = (p) =>
    latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] ?? null;
  return {
    requests: samples.length,
    failures: samples.filter((sample) => sample.status !== '200').length,
    statuses: samples.reduce(
      (counts, sample) => ({
        ...counts,
        [sample.status]: (counts[sample.status] ?? 0) + 1,
      }),
      {},
    ),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

async function run() {
  const base = new URL(values.url);
  if (
    base.protocol !== 'http:' ||
    !localHosts.has(base.hostname) ||
    base.username ||
    base.password
  )
    throw new Error('--url must be an unauthenticated loopback HTTP server');
  const concurrency = integer('concurrency', 1, 1000);
  const seconds = integer('seconds');
  const warmup = integer('warmup', 0);
  const timeout = integer('timeout-ms');
  const infoResponse = await fetch(new URL('/__benchmark/info', base), {
    signal: AbortSignal.timeout(timeout),
    redirect: 'error',
  });
  if (!infoResponse.ok) throw new Error('Benchmark info endpoint unavailable');
  const info = await infoResponse.json();
  if (
    info.fixture !== 'job-search-v1' ||
    info.activeJobs < integer('minimum-jobs')
  )
    throw new Error(
      'Fixture identity/active-job count does not meet --minimum-jobs',
    );
  const { JwtService } = await import('@nestjs/jwt');
  const token = new JwtService().sign(
    { sub: 42, role: 'SEEKER', email: 'seeker@benchmark.invalid' },
    { secret: benchSecret, expiresIn: '1h' },
  );
  async function exercise(duration, record) {
    const samples = [];
    const start = performance.now();
    const end = start + duration * 1000;
    await Promise.all(
      Array.from({ length: concurrency }, async (_, client) => {
        let iteration = client;
        while (performance.now() < end) {
          const [name, path] = scenarios[iteration++ % scenarios.length];
          const requestStart = performance.now();
          let status;
          try {
            const response = await fetch(new URL(path, base), {
              signal: AbortSignal.timeout(timeout),
              redirect: 'error',
              headers: { Authorization: `Bearer ${token}` },
            });
            await response.arrayBuffer(); // Include complete response-body transfer.
            status = String(response.status);
          } catch (error) {
            status =
              error.name === 'TimeoutError' ? 'timeout' : 'network-error';
          }
          if (record)
            samples.push({
              name,
              ms: performance.now() - requestStart,
              status,
            });
        }
      }),
    );
    return { samples, elapsedSeconds: (performance.now() - start) / 1000 };
  }
  await exercise(warmup, false);
  const { samples, elapsedSeconds } = await exercise(seconds, true);
  const search = summary(
    samples.filter((sample) => sample.name !== 'detail-control'),
  );
  const report = {
    label: values.label,
    fixture: info.fixture,
    activeJobs: info.activeJobs,
    node: process.version,
    concurrency,
    measurementSeconds: seconds,
    warmupSeconds: warmup,
    elapsedSeconds,
    requestsPerSecond: samples.length / elapsedSeconds,
    search,
    scenarios: Object.fromEntries(
      scenarios.map(([name]) => [
        name,
        summary(samples.filter((sample) => sample.name === name)),
      ]),
    ),
    acceptance: {
      nfr05_1:
        concurrency === 100 && info.activeJobs >= 1000
          ? search.requests > 0 && search.failures === 0 && search.p95Ms <= 2000
          : null,
      nfr05_2:
        concurrency === 500 && info.activeJobs >= 3000
          ? search.requests > 0 && search.failures === 0 && search.p95Ms <= 3000
          : null,
    },
  };
  if (values.out) {
    await mkdir(dirname(resolve(values.out)), { recursive: true });
    await writeFile(values.out, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  if (search.failures) process.exitCode = 1;
}

try {
  if (values.help) {
    console.log(
      'Usage: node scripts/benchmark-jobs-search.mjs seed|serve|run [options]\nSee docs/job-search-performance.md. No .env is loaded.',
    );
  } else {
    const command = { seed, serve, run }[positionals[0]];
    if (!command) throw new Error('Choose seed, serve or run; see --help');
    await command();
  }
} catch (error) {
  // Keep potentially credential-bearing connection errors out of console output.
  console.error(
    `Benchmark failed (${error.name}). Check local setup and docs/job-search-performance.md.`,
  );
  process.exitCode = 1;
}
