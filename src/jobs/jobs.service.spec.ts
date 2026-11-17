import { BadRequestException } from '@nestjs/common';
import { JobsService } from './jobs.service.js';
import type { SearchTimings } from './job-search.diagnostics.js';

const companies = [
  { company_id: 1, company_name: 'Acme', city: 'Hà Nội' },
  { company_id: 2, company_name: 'React Labs', city: 'Đà Nẵng' },
];
const categories = [
  { category_id: 1, name: 'Web' },
  { category_id: 2, name: 'React Engineering' },
];
const types = [
  { job_type_id: 1, job_type: 'Full-time' },
  { job_type_id: 2, job_type: 'React Contract' },
];
const skills = [{ skill_id: 1, skill_name: 'React' }];

function job(id: number, overrides: Record<string, unknown> = {}) {
  return {
    job_post_id: id,
    company_id: 1,
    category_id: 1,
    job_type_id: 1,
    name: 'Engineer',
    job_title: 'Engineer',
    job_description: 'Build systems',
    candidate_requirements: 'Experience',
    work_location: null,
    work_type: 'REMOTE',
    level: 'Junior',
    salary: '10M-20M',
    is_active: true,
    created_date: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// A scalar-filter repository fake exercises selection, totals and pagination
// together. It deliberately cannot interpret relation predicates.
function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, condition]: [string, any]) => {
    if (key === 'AND')
      return condition.every((part: any) => matches(row, part));
    if (key === 'OR') return condition.some((part: any) => matches(row, part));
    if (condition === null || typeof condition !== 'object')
      return row[key] === condition;
    if ('contains' in condition)
      return (
        typeof row[key] === 'string' &&
        row[key].toLowerCase().includes(condition.contains.toLowerCase())
      );
    if ('in' in condition) return condition.in.includes(row[key]);
    if ('notIn' in condition) return !condition.notIn.includes(row[key]);
    throw new Error(`Unsupported fake filter: ${key}`);
  });
}

function setup(rows = [job(1)], links = [{ job_post_id: 9, skill_id: 1 }]) {
  const table = (data: any[]) => ({
    findMany: jest.fn(async ({ where }: any) =>
      data.filter((row) => matches(row, where)),
    ),
  });
  const prisma = {
    company: table(companies),
    category: table(categories),
    jobType: table(types),
    skill: table(skills),
    jobPostSkill: table(links),
    jobPostActivity: table([{ seeker_id: 42, job_post_id: 2 }]),
    jobPost: {
      aggregateRaw: jest.fn(async ({ pipeline }: any) => {
        // Independent native-filter interpreter for the compact-path tests.
        const nativeMatches = (row: any, filter: any): boolean =>
          Object.entries(filter).every(([key, condition]: [string, any]) => {
            if (key === '$and')
              return condition.every((part: any) => nativeMatches(row, part));
            if (key === '$or')
              return condition.some((part: any) => nativeMatches(row, part));
            const value = row[key === '_id' ? 'job_post_id' : key];
            if (!condition || typeof condition !== 'object')
              return value === condition;
            if ('$in' in condition) return condition.$in.includes(value);
            if ('$nin' in condition)
              return value !== undefined && !condition.$nin.includes(value);
            if ('$regex' in condition)
              return (
                typeof value === 'string' &&
                new RegExp(condition.$regex, condition.$options).test(value)
              );
            throw Error('Unsupported native fixture filter');
          });
        let selected = rows.filter((row) =>
          nativeMatches(row, pipeline[0].$match),
        );
        if (pipeline.some((stage: any) => stage.$count))
          return selected.length
            ? [{ total: { $numberLong: String(selected.length) } }]
            : [];
        selected = [...selected].sort(
          (a, b) =>
            b.created_date.getTime() - a.created_date.getTime() ||
            b.job_post_id - a.job_post_id,
        );
        const skip = pipeline.find((stage: any) => '$skip' in stage).$skip;
        const take = pipeline.find((stage: any) => '$limit' in stage).$limit;
        return selected
          .slice(skip, skip + take)
          .map((row) => ({ _id: { $numberLong: String(row.job_post_id) } }));
      }),
      findMany: jest.fn(
        async ({ where, skip = 0, take, select, orderBy }: any) => {
          const sorted = rows
            .filter((row) => matches(row, where))
            .sort((a, b) => {
              for (const order of orderBy) {
                const [field, direction] = Object.entries(order)[0];
                const delta =
                  a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0;
                if (delta) return direction === 'desc' ? -delta : delta;
              }
              return 0;
            });
          return sorted
            .slice(skip, take === undefined ? undefined : skip + take)
            .map((row) => {
              if (!select.Company)
                return { job_post_id: row.job_post_id, salary: row.salary };
              return {
                ...row,
                Company: companies.find(
                  (company) => company.company_id === row.company_id,
                ),
                Category: categories.find(
                  (category) => category.category_id === row.category_id,
                ),
                JobType: types.find(
                  (type) => type.job_type_id === row.job_type_id,
                ),
                JobPostSkill: links
                  .filter((link) => link.job_post_id === row.job_post_id)
                  .slice(0, 10)
                  .map((link) => ({
                    Skill: skills.find(
                      (skill) => skill.skill_id === link.skill_id,
                    ),
                  })),
              };
            });
        },
      ),
      count: jest.fn(
        async ({ where }: any) =>
          rows.filter((row) => matches(row, where)).length,
      ),
    },
  };
  return { prisma, service: new JobsService(prisma as never, {} as never) };
}

const query = (overrides: Record<string, unknown> = {}) => ({
  page: 1,
  limit: 20,
  ...overrides,
});

describe('JobsService search', () => {
  const keywordRows = [
    job(1, { name: 'React engineer' }),
    job(2, { job_title: 'REACT developer' }),
    job(3, { job_description: 'Use React daily' }),
    job(4, { candidate_requirements: 'Know React' }),
    job(5, { work_location: 'React campus' }),
    job(6, { company_id: 2 }),
    job(7, { category_id: 2 }),
    job(8, { job_type_id: 2 }),
    job(9), // matches only through its linked skill
    job(10),
    job(11, { name: 'React', is_active: false }),
  ];

  const largeSkillLinks = Array.from({ length: 1000 }, (_, index) => ({
    job_post_id: index + 100,
    skill_id: 1,
  }));

  it.each([
    { q: 'React' },
    { q: 'React', page: 2, limit: 2 },
    { q: 'React', category: 'Web' },
    { q: 'React', location: 'Hà Nội' },
    { q: 'React', excludeApplied: true },
    { q: 'React', category: 'Web', location: 'Hà Nội', excludeApplied: true },
  ])(
    'matches the complete existing API contract across every keyword source: %j',
    async (filter) => {
      const links = [{ job_post_id: 9, skill_id: 1 }];
      const baseline = setup(keywordRows, links);
      const optimized = setup(keywordRows, [
        ...links,
        ...Array.from({ length: 999 }, (_, index) => ({
          job_post_id: 10000 + index,
          skill_id: 1,
        })),
      ]);
      const user = { sub: 42, role: 'SEEKER' as const };
      expect(await optimized.service.searchJobs(query(filter), user)).toEqual(
        await baseline.service.searchJobs(query(filter), user),
      );
      expect(optimized.prisma.jobPost.aggregateRaw).toHaveBeenCalledTimes(2);
    },
  );

  it('uses compact large membership with exact totals, stable pages and unchanged hydration', async () => {
    const { service, prisma } = setup(
      [
        job(1, { name: 'React Engineer' }),
        job(101),
        job(102),
        job(103, { is_active: false }),
        job(4, { salary: null }),
      ],
      largeSkillLinks,
    );
    const first = await service.searchJobs(query({ q: 'React', limit: 2 }));
    const second = await service.searchJobs(
      query({ q: 'React', limit: 2, page: 2 }),
    );
    expect(first.jobs.map((row) => row.id)).toEqual([102, 101]);
    expect(second.jobs.map((row) => row.id)).toEqual([1]);
    expect([first.total, second.total]).toEqual([3, 3]);
    expect(prisma.jobPost.count).not.toHaveBeenCalled();
    expect(prisma.jobPost.aggregateRaw).toHaveBeenCalledTimes(4);
    expect(prisma.jobPost.findMany.mock.calls[0][0].where).toEqual({
      job_post_id: { in: [102, 101] },
    });
    expect(
      prisma.jobPost.findMany.mock.calls[0][0].select.JobPostSkill.take,
    ).toBe(10);
    expect(first.jobs[0].company).toEqual(companies[0]);
    expect(first.jobs[0].skills).toEqual(['React']);
  });

  it('combines compact selection with category, location and seeker exclusion', async () => {
    const { service } = setup(
      [
        job(2, { name: 'React' }), // application exclusion
        job(101),
        job(102, { company_id: 2 }),
        job(103, { category_id: 2 }),
        job(104, { work_location: 'Remote' }),
      ],
      largeSkillLinks,
    );
    const result = await service.searchJobs(
      query({
        q: 'React',
        category: 'Web',
        location: 'hà nội',
        excludeApplied: true,
      }),
      { sub: 42, role: 'SEEKER' },
    );
    expect(result.jobs.map((row) => row.id)).toEqual([104, 101]);
    expect(result.total).toBe(2);
  });

  it('skips compact hydration beyond the final page and keeps its exact total', async () => {
    const { service, prisma } = setup([job(101)], largeSkillLinks);
    const result = await service.searchJobs(query({ q: 'React', page: 2 }));
    expect(result.jobs).toEqual([]);
    expect(result.total).toBe(1);
    expect(prisma.jobPost.findMany).not.toHaveBeenCalled();
  });

  it('returns zero for an empty compact count and avoids hydration', async () => {
    const { service, prisma } = setup([job(4)], largeSkillLinks);
    const result = await service.searchJobs(query({ q: 'React' }));
    expect(result.jobs).toEqual([]);
    expect(result.total).toBe(0);
    expect(prisma.jobPost.findMany).not.toHaveBeenCalled();
  });

  it('keeps salary filtering and exact salary totals on the existing path with a large skill branch', async () => {
    const { service, prisma } = setup(
      [job(101), job(102, { salary: '40M' })],
      largeSkillLinks,
    );
    const result = await service.searchJobs(
      query({ q: 'React', salaryMax: '30M' }),
    );
    expect(result.jobs.map((row) => row.id)).toEqual([101]);
    expect(result.total).toBe(1);
    expect(prisma.jobPost.aggregateRaw).not.toHaveBeenCalled();
  });

  it('reports selection and hydration independently for compact searches', async () => {
    const { service } = setup([job(101)], largeSkillLinks);
    const timings: SearchTimings = {
      filterResolutionMs: 0,
      findManyMs: 0,
      countMs: 0,
      salaryFilterMs: 0,
      mappingMs: 0,
      documentsReturned: 0,
      candidateDocuments: 0,
      countExecuted: false,
    };
    await service.searchJobs(query({ q: 'React' }), undefined, timings);
    expect(timings.databaseStrategy).toBe('compactMembership');
    expect(timings.pageSelectionMs).toBeGreaterThanOrEqual(0);
    expect(timings.hydrationMs).toBeGreaterThanOrEqual(0);
    expect(timings.findManyMs).toBeGreaterThanOrEqual(timings.hydrationMs!);
    expect(timings.countExecuted).toBe(true);
  });

  it('preserves every keyword source, case-insensitive substring matching and active filtering', async () => {
    const { service, prisma } = setup(keywordRows);
    const result = await service.searchJobs(query({ q: '  ReAcT  ' }));
    expect(result.jobs.map((job) => job.id)).toEqual([
      9, 8, 7, 6, 5, 4, 3, 2, 1,
    ]);
    expect(result.total).toBe(9);
    expect(prisma.skill.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.jobPostSkill.findMany).toHaveBeenCalledTimes(1);
    const pageWhere = prisma.jobPost.findMany.mock.calls[0][0].where;
    expect(prisma.jobPost.count).toHaveBeenCalledWith({ where: pageWhere });
    expect(JSON.stringify(pageWhere)).not.toMatch(
      /"(Company|Category|JobType|JobPostSkill)"/,
    );
  });

  it('ANDs keyword with location matching either work location or company city', async () => {
    const { service } = setup(
      [
        job(1, { name: 'React', work_location: 'Remote Hà Nội' }),
        job(2, { name: 'React', company_id: 2 }),
        job(3, { name: 'React' }),
        job(4),
      ],
      [],
    );
    const result = await service.searchJobs(
      query({ q: 'react', location: 'hà nội' }),
    );
    expect(result.jobs.map((job) => job.id)).toEqual([3, 1]);
    expect(result.total).toBe(2);
  });

  it('filters category by substring and combines it with keyword and location', async () => {
    const { service } = setup(keywordRows);
    expect(
      (
        await service.searchJobs(
          query({ category: 'eB', q: 'react', location: 'Hà Nội' }),
        )
      ).jobs.map((job) => job.id),
    ).toEqual([9, 8, 5, 4, 3, 2, 1]);
    expect(
      (await service.searchJobs(query({ category: 'missing' }))).total,
    ).toBe(0);
  });

  it('filters salary before pagination, hydrates only page IDs, and computes the filtered total', async () => {
    const { service, prisma } = setup(
      [
        job(1, { salary: '15M-25M' }),
        job(2, { salary: '20M-30M' }),
        job(3, { salary: '40M-45M' }),
        job(4, { salary: '12M-22M' }),
        job(5, { salary: null }),
        job(6, { salary: 'Negotiable' }),
        job(7, { salary: '1M-5M' }),
      ],
      [],
    );
    const filter = { salaryMin: '10M', salaryMax: '30M', limit: 2 };
    const first = await service.searchJobs(query(filter));
    const second = await service.searchJobs(query({ ...filter, page: 2 }));
    expect(first.jobs.map((job) => job.id)).toEqual([4, 2]);
    expect(second.jobs.map((job) => job.id)).toEqual([1]);
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
    expect(prisma.jobPost.count).not.toHaveBeenCalled();
    expect(prisma.jobPost.findMany.mock.calls[0][0].select).toEqual({
      job_post_id: true,
      salary: true,
    });
    expect(prisma.jobPost.findMany.mock.calls[1][0].where).toEqual({
      job_post_id: { in: [4, 2] },
    });
  });

  it.each([
    [{ salaryMin: '20M' }, [3, 2]],
    [{ salaryMax: '20M' }, [3, 1]],
    [{ salaryMin: '0', salaryMax: '0' }, []],
  ])(
    'preserves salary range containment and single-value/range parsing for %j',
    async (filter, ids) => {
      const { service } = setup(
        [
          job(1, { salary: '10m-15m' }),
          job(2, { salary: '30,000,000 VND-20,000,000 VND' }),
          job(3, { salary: '20M' }),
          job(4, { salary: 'Thỏa thuận' }),
        ],
        [],
      );
      expect(
        (await service.searchJobs(query(filter))).jobs.map((job) => job.id),
      ).toEqual(ids);
    },
  );

  it('combines salary with keyword, category, location and excludeApplied', async () => {
    const { service } = setup(keywordRows);
    const result = await service.searchJobs(
      query({
        q: 'react',
        category: 'web',
        location: 'Hà Nội',
        salaryMin: '10M',
        salaryMax: '20M',
        excludeApplied: true,
      }),
      { sub: 42, role: 'SEEKER' },
    );
    expect(result.jobs.map((job) => job.id)).toEqual([9, 8, 5, 4, 3, 1]);
    expect(result.total).toBe(6);
  });

  it('returns an empty page with the correct total when the page is beyond the end', async () => {
    const { service } = setup([job(1)]);
    const result = await service.searchJobs(query({ page: 2, limit: 1 }));
    expect(result.jobs).toEqual([]);
    expect(result.total).toBe(1);
  });

  it('returns an empty contract when nothing matches and skips salary hydration', async () => {
    const { service, prisma } = setup([job(1)]);
    const result = await service.searchJobs(
      query({ q: 'nonexistent', salaryMin: '50M' }),
    );
    expect(result).toEqual({
      jobs: [],
      total: 0,
      page: 1,
      limit: 20,
      filters: {
        categories: [],
        locations: expect.arrayContaining(['Remote', 'Hà Nội']),
        jobTypes: expect.arrayContaining([
          { label: 'Full-time', value: 'Full-time', count: 0 },
        ]),
        programmingLanguages: expect.arrayContaining([
          { label: 'React', value: 'React', count: 0 },
        ]),
      },
    });
    expect(prisma.jobPost.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.jobPostSkill.findMany).not.toHaveBeenCalled();
  });

  it('keeps pages disjoint and repeatable when creation dates are identical', async () => {
    const { service, prisma } = setup([job(1), job(3), job(2)]);
    const first = await service.searchJobs(query({ limit: 2 }));
    const second = await service.searchJobs(query({ limit: 2, page: 2 }));
    expect(first.jobs.map((job) => job.id)).toEqual([3, 2]);
    expect(second.jobs.map((job) => job.id)).toEqual([1]);
    expect([first.total, second.total]).toEqual([3, 3]);
    expect(prisma.company.findMany).not.toHaveBeenCalled();
    expect(prisma.category.findMany).not.toHaveBeenCalled();
    expect(prisma.jobPostActivity.findMany).not.toHaveBeenCalled();
  });

  it('excludes applications of any status only for an authenticated seeker who opts in', async () => {
    const { service, prisma } = setup([job(1), job(2), job(3)]);
    expect(
      (
        await service.searchJobs(query({ excludeApplied: true }), {
          sub: 42,
          role: 'SEEKER',
        })
      ).jobs.map((job) => job.id),
    ).toEqual([3, 1]);
    expect(prisma.jobPostActivity.findMany).toHaveBeenCalledWith({
      where: { seeker_id: 42 },
      select: { job_post_id: true },
    });
    for (const user of [
      undefined,
      { sub: 42, role: 'EMPLOYEE' as const },
      { sub: 42, role: 'ADMIN' as const },
    ]) {
      expect(
        (await service.searchJobs(query({ excludeApplied: true }), user)).total,
      ).toBe(3);
    }
    expect(
      (await service.searchJobs(query(), { sub: 42, role: 'SEEKER' })).total,
    ).toBe(3);
    expect(prisma.jobPostActivity.findMany).toHaveBeenCalledTimes(1);
  });

  it('preserves the response fields, fallback skills and page-scoped filter counts', async () => {
    const { service } = setup(
      [job(1, { job_title: '', name: 'React Developer' })],
      [],
    );
    const result = await service.searchJobs(query());
    expect(result.jobs[0]).toEqual({
      id: 1,
      title: 'React Developer',
      description: 'Build systems',
      requirements: 'Experience',
      salary: '10M-20M',
      salaryRange: { min: 10_000_000, max: 20_000_000 },
      location: 'Hà Nội',
      workType: 'REMOTE',
      level: 'Junior',
      skills: ['React'],
      isActive: true,
      createdDate: new Date('2026-01-01T00:00:00Z'),
      company: companies[0],
      category: categories[0],
      jobType: types[0],
    });
    expect(result.filters.categories).toEqual(['Web']);
    expect(
      result.filters.programmingLanguages.find((item) => item.value === 'React')
        ?.count,
    ).toBe(1);
  });

  it.each([
    { salaryMin: 'invalid' },
    { salaryMax: '-1' },
    { salaryMin: '30M', salaryMax: '10M' },
  ])(
    'rejects invalid salary inputs before database work: %j',
    async (filter) => {
      const { service, prisma } = setup();
      await expect(service.searchJobs(query(filter))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.jobPost.findMany).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'collects operation timings and returned/candidate counts (salary=%s)',
    async (salary) => {
      const timings: SearchTimings = {
        filterResolutionMs: 0,
        findManyMs: 0,
        countMs: 0,
        salaryFilterMs: 0,
        mappingMs: 0,
        documentsReturned: 0,
        candidateDocuments: 0,
        countExecuted: false,
      };
      const { service } = setup([job(1), job(2)]);
      await service.searchJobs(
        query({ limit: 1, ...(salary ? { salaryMin: '10M' } : {}) }),
        undefined,
        timings,
      );
      expect(timings.documentsReturned).toBe(1);
      expect(timings.candidateDocuments).toBe(salary ? 2 : 0);
      expect(timings.countExecuted).toBe(!salary);
      expect(timings.findManyMs).toBeGreaterThanOrEqual(0);
      expect(timings.mappingMs).toBeGreaterThanOrEqual(0);
      expect(timings.filterResolutionMs).toBeGreaterThanOrEqual(0);
    },
  );

  it('keeps Java as a substring, including JavaScript, rather than a word/prefix match', async () => {
    const { service } = setup(
      [
        job(1, { name: 'Senior Java Engineer' }),
        job(2, { job_title: 'JavaScript Developer' }),
        job(3, { candidate_requirements: 'Experience with java APIs' }),
        job(4, { name: 'Python Engineer' }),
      ],
      [],
    );
    const result = await service.searchJobs(query({ q: 'Java', limit: 2 }));
    expect(result.jobs.map((item) => item.id)).toEqual([3, 2]);
    expect(result.total).toBe(3);
    expect(
      (
        await service.searchJobs(query({ q: 'Java', limit: 2, page: 2 }))
      ).jobs.map((item) => item.id),
    ).toEqual([1]);
  });

  it('shares an identical trimmed keyword/category read within a request only', async () => {
    const { service, prisma } = setup(keywordRows);
    const filter = query({ q: ' React ', category: 'React' });
    const first = await service.searchJobs(filter);
    expect(first.jobs.map((item) => item.id)).toEqual([7]);
    expect(first.total).toBe(1);
    expect(prisma.category.findMany).toHaveBeenCalledTimes(1);
    await service.searchJobs(filter);
    expect(prisma.category.findMany).toHaveBeenCalledTimes(2);
  });

  it('retains separate category lookups for different keyword/category predicates', async () => {
    const { service, prisma } = setup(keywordRows);
    const result = await service.searchJobs(
      query({ q: 'React', category: 'Web' }),
    );
    expect(result.total).toBe(8);
    expect(prisma.category.findMany).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'skips page/count/candidate reads for an impossible category (salary=%s)',
    async (salary) => {
      const { service, prisma } = setup(keywordRows);
      const result = await service.searchJobs(
        query({
          q: 'React',
          category: 'missing-category',
          ...(salary ? { salaryMin: '10M' } : {}),
        }),
      );
      expect(result.jobs).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.filters.categories).toEqual([]);
      expect(result.filters.jobTypes.every((item) => item.count === 0)).toBe(
        true,
      );
      expect(prisma.jobPost.findMany).not.toHaveBeenCalled();
      expect(prisma.jobPost.count).not.toHaveBeenCalled();
    },
  );

  it('records each executed relation query without query values or returned records', async () => {
    const timings: SearchTimings = {
      filterResolutionMs: 0,
      findManyMs: 0,
      countMs: 0,
      salaryFilterMs: 0,
      mappingMs: 0,
      documentsReturned: 0,
      candidateDocuments: 0,
      countExecuted: false,
    };
    const { service } = setup(keywordRows);
    await service.searchJobs(
      query({
        q: 'React',
        category: 'Web',
        location: 'Hà Nội',
        excludeApplied: true,
      }),
      { sub: 42, role: 'SEEKER' },
      timings,
    );
    expect(Object.keys(timings.relationQueries ?? {}).sort()).toEqual([
      'appliedJobs',
      'categoryFilter',
      'categoryKeyword',
      'companyKeyword',
      'companyLocation',
      'jobTypeKeyword',
      'skillJobs',
      'skillKeyword',
    ]);
    for (const entry of Object.values(timings.relationQueries ?? {})) {
      expect(entry).toEqual({
        durationMs: expect.any(Number),
        rowsReturned: 1,
        failed: false,
      });
    }
    expect(JSON.stringify(timings)).not.toMatch(
      /React|Web|Hà Nội|seeker_id|company_id|skill_id/,
    );
  });
});
