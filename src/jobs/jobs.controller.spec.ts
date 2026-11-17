import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { OptionalJwtAuthGuard } from '../jwt/optional-jwt-auth.guard.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { JobSearchDiagnosticsMiddleware } from './job-search.diagnostics.js';

describe('Jobs search HTTP contract and diagnostics', () => {
  let app: INestApplication;
  let search: jest.Mock;
  const previousDiagnostics = process.env.JOB_SEARCH_DIAGNOSTICS;

  beforeEach(async () => {
    search = jest
      .fn()
      .mockResolvedValue({
        jobs: [],
        total: 0,
        page: 1,
        limit: 20,
        filters: {},
      });
    const module = await Test.createTestingModule({
      controllers: [JobsController],
      providers: [{ provide: JobsService, useValue: { searchJobs: search } }],
    })
      .overrideGuard(OptionalJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    const middleware = new JobSearchDiagnosticsMiddleware();
    app.use('/jobs/search', middleware.use.bind(middleware));
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    if (previousDiagnostics === undefined)
      delete process.env.JOB_SEARCH_DIAGNOSTICS;
    else process.env.JOB_SEARCH_DIAGNOSTICS = previousDiagnostics;
    jest.restoreAllMocks();
  });

  it('routes /jobs/search before /jobs/:id and transforms the public query DTO', async () => {
    delete process.env.JOB_SEARCH_DIAGNOSTICS;
    await request(app.getHttpServer())
      .get(
        '/jobs/search?q=react&category=web&location=HN&salaryMin=10M&page=2&limit=5&excludeApplied=false',
      )
      .expect(200);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'react',
        category: 'web',
        location: 'HN',
        salaryMin: '10M',
        page: 2,
        limit: 5,
        excludeApplied: false,
      }),
      undefined,
      undefined,
    );
  });

  it('rejects invalid pagination and unknown fields before reaching the service', async () => {
    await request(app.getHttpServer())
      .get('/jobs/search?limit=101')
      .expect(400);
    await request(app.getHttpServer()).get('/jobs/search?page=0').expect(400);
    await request(app.getHttpServer())
      .get('/jobs/search?unknown=value')
      .expect(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('does not collect or log timings when diagnostics are disabled', async () => {
    delete process.env.JOB_SEARCH_DIAGNOSTICS;
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    await request(app.getHttpServer()).get('/jobs/search').expect(200);
    expect(search.mock.calls[0][2]).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs only timing/count/status metadata after the response finishes', async () => {
    process.env.JOB_SEARCH_DIAGNOSTICS = 'true';
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    await request(app.getHttpServer())
      .get('/jobs/search?q=private-keyword')
      .set('Authorization', 'Bearer private-token')
      .expect(200);
    expect(search.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        findManyMs: 0,
        countMs: 0,
        mappingMs: 0,
        documentsReturned: 0,
      }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'job_search_timing',
        statusCode: 200,
        totalMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /private-keyword|private-token|Authorization/,
    );
  });

  it('records failed validation requests without exposing the rejected query', async () => {
    process.env.JOB_SEARCH_DIAGNOSTICS = 'true';
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    await request(app.getHttpServer())
      .get('/jobs/search?secret=private-value')
      .expect(400);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, totalMs: expect.any(Number) }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-value');
  });
});
