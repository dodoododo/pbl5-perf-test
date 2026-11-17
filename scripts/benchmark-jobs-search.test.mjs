import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

function child(args, env = {}) {
  const process = spawn(
    globalThis.process.execPath,
    ['scripts/benchmark-jobs-search.mjs', ...args],
    {
      env: { ...globalThis.process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  process.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  process.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const done = once(process, 'exit').then(([code]) => ({
    code,
    stdout,
    stderr,
  }));
  return { process, done };
}

test('load generator measures all scenarios and records HTTP 429 without retrying it', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/__benchmark/info') {
      res.end(JSON.stringify({ fixture: 'job-search-v1', activeJobs: 1000 }));
    } else {
      requests++;
      res.statusCode = requests === 1 ? 429 : 200;
      res.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const run = child([
      'run',
      '--url',
      `http://127.0.0.1:${server.address().port}`,
      '--concurrency',
      '2',
      '--seconds',
      '1',
      '--warmup',
      '0',
    ]);
    const { code, stdout } = await run.done;
    assert.equal(code, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.search.statuses['429'], 1);
    assert.equal(report.search.failures, 1);
    assert.ok(report.search.p95Ms >= 0);
    assert.ok(
      Object.values(report.scenarios).every(
        (scenario) => scenario.requests > 0,
      ),
    );
    assert.equal(report.acceptance.nfr05_1, null);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('seeding refuses a remote database before issuing any database operation', async () => {
  const result = await child(['seed'], {
    BENCH_DATABASE_URL: 'mongodb://production.example/job_search_bench_1000',
  }).done;
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /production\.example/);
});

test(
  'compiled harness boots and validates a request without a database connection',
  { timeout: 15000 },
  async () => {
    const portServer = createServer();
    portServer.listen(0, '127.0.0.1');
    await once(portServer, 'listening');
    const port = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    const run = child(['serve', '--port', String(port)], {
      BENCH_DATABASE_URL:
        'mongodb://127.0.0.1:27017/job_search_bench_smoke?directConnection=true&serverSelectionTimeoutMS=1000',
      JOB_SEARCH_DIAGNOSTICS: 'false',
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Harness did not start')),
          10000,
        );
        run.process.stdout.on('data', (chunk) => {
          if (chunk.toString().includes('harness ready')) {
            clearTimeout(timer);
            resolve();
          }
        });
        run.process.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Harness exited before ready'));
        });
      });
      const response = await fetch(
        `http://127.0.0.1:${port}/jobs/search?limit=101`,
      );
      assert.equal(response.status, 400);
      await response.arrayBuffer();
    } finally {
      run.process.kill();
      await run.done;
    }
  },
);
