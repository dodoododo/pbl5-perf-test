import {
  compactJobSearchMatch,
  largeJobSearchMatch,
  searchInteger,
} from './job-search.mongo.js';

describe('compact job search predicates', () => {
  it('preserves all keyword/location branches, category AND and seeker exclusion', () => {
    expect(
      compactJobSearchMatch({
        is_active: true,
        category_id: { in: [3] },
        job_post_id: { notIn: [7] },
        AND: [
          {
            OR: [
              ...[
                'name',
                'job_title',
                'job_description',
                'candidate_requirements',
                'work_location',
              ].map((field) => ({
                [field]: { contains: 'Java', mode: 'insensitive' as const },
              })),
              { company_id: { in: [1] } },
              { category_id: { in: [2] } },
              { job_type_id: { in: [4] } },
              { job_post_id: { in: [5, 6] } },
            ],
          },
          {
            OR: [
              { work_location: { contains: 'Remote', mode: 'insensitive' } },
              { company_id: { in: [8] } },
            ],
          },
        ],
      }),
    ).toEqual({
      is_active: true,
      category_id: { $in: [3] },
      _id: { $nin: [7], $exists: true },
      $and: [
        {
          $or: [
            ...[
              'name',
              'job_title',
              'job_description',
              'candidate_requirements',
              'work_location',
            ].map((field) => ({
              [field]: { $regex: '.*Java.*', $options: 'i' },
            })),
            { company_id: { $in: [1] } },
            { category_id: { $in: [2] } },
            { job_type_id: { $in: [4] } },
            { _id: { $in: [5, 6] } },
          ],
        },
        {
          $or: [
            { work_location: { $regex: '.*Remote.*', $options: 'i' } },
            { company_id: { $in: [8] } },
          ],
        },
      ],
    });
  });

  it('retains captured Prisma contains regex behavior, without word/prefix anchoring or escaping', () => {
    expect(
      compactJobSearchMatch({
        name: { contains: 'a+b[.]$x', mode: 'insensitive' },
      }),
    ).toEqual({ name: { $regex: '.*a+b[.]$x.*', $options: 'i' } });
    const expression = new RegExp('.*Java.*', 'i');
    expect(expression.test('Senior JavaScript Developer')).toBe(true);
  });

  it.each([
    { NOT: { is_active: false } },
    { created_date: { gt: new Date() } },
    { Company: { is: { company_name: 'Acme' } } },
    { name: { startsWith: 'Java' } },
    { job_post_id: { in: [Number.MAX_SAFE_INTEGER + 1] } },
    { name: { contains: 'Java', mode: 'default' } },
    { AND: [] },
    { OR: [] },
    { is_active: false },
  ])('falls back on unsupported predicates: %j', (where) => {
    expect(compactJobSearchMatch(where as never)).toBeUndefined();
  });

  it('keeps the old path for small searches and unsupported large filters', () => {
    const branch = (size: number) => ({
      is_active: true,
      AND: [
        {
          OR: [
            {
              job_post_id: {
                in: Array.from({ length: size }, (_, index) => index),
              },
            },
          ],
        },
      ],
    });
    expect(largeJobSearchMatch(branch(999))).toBeUndefined();
    expect(largeJobSearchMatch(branch(1000))).toBeDefined();
    expect(
      largeJobSearchMatch({ ...branch(1000), name: { equals: 'Java' } }),
    ).toBeUndefined();
  });

  it('decodes BSON Long IDs/totals exactly within the API numeric range', () => {
    expect(searchInteger({ $numberLong: '2147483647' })).toBe(2147483647);
    expect(searchInteger(0)).toBe(0);
    for (const value of [
      { $numberLong: '9007199254740993' },
      { $numberLong: 'NaN' },
      { $numberLong: '' },
      null,
      {},
      '12',
      1.5,
    ]) {
      expect(() => searchInteger(value)).toThrow('Invalid integer');
    }
  });
});
