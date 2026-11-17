import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma.service.js';
import type { SearchJobsQueryDto } from './dto/search-jobs.query.dto.js';
import {
  timeSearchRelation,
  type SearchTimings,
} from './job-search.diagnostics.js';

export type SearchUser = {
  sub: number;
  role: 'SEEKER' | 'EMPLOYEE' | 'ADMIN';
};

const contains = (value: string) => ({
  contains: value,
  mode: 'insensitive' as const,
});

async function findSkillJobIds(
  prisma: PrismaService,
  keyword: string,
  timings?: SearchTimings,
) {
  const skills = await timeSearchRelation(timings, 'skillKeyword', () =>
    prisma.skill.findMany({
      where: { skill_name: contains(keyword) },
      select: { skill_id: true },
    }),
  );
  if (!skills.length) return [];

  const links = await timeSearchRelation(timings, 'skillJobs', () =>
    prisma.jobPostSkill.findMany({
      where: { skill_id: { in: skills.map((skill) => skill.skill_id) } },
      select: { job_post_id: true },
    }),
  );
  return [...new Set(links.map((link) => link.job_post_id))];
}

/** Resolve related matches once, so page/count queries need no filter joins. */
export async function buildJobSearchWhere(
  prisma: PrismaService,
  query: SearchJobsQueryDto,
  user?: SearchUser,
  timings?: SearchTimings,
): Promise<Prisma.JobPostWhereInput> {
  const keyword = query.q?.trim();
  const category = query.category?.trim();
  const location = query.location?.trim();
  // Identical category predicates share one read only within this request.
  // Do not cache across requests or alter case/substring semantics.
  const keywordCategories = keyword
    ? timeSearchRelation(timings, 'categoryKeyword', () =>
        prisma.category.findMany({
          where: { name: contains(keyword) },
          select: { category_id: true },
        }),
      )
    : Promise.resolve([]);
  const [
    companies,
    categories,
    types,
    skillJobIds,
    cities,
    categoryFilter,
    applied,
  ] = await Promise.all([
    keyword
      ? timeSearchRelation(timings, 'companyKeyword', () =>
          prisma.company.findMany({
            where: { company_name: contains(keyword) },
            select: { company_id: true },
          }),
        )
      : [],
    keywordCategories,
    keyword
      ? timeSearchRelation(timings, 'jobTypeKeyword', () =>
          prisma.jobType.findMany({
            where: { job_type: contains(keyword) },
            select: { job_type_id: true },
          }),
        )
      : [],
    keyword ? findSkillJobIds(prisma, keyword, timings) : [],
    location
      ? timeSearchRelation(timings, 'companyLocation', () =>
          prisma.company.findMany({
            where: { city: contains(location) },
            select: { company_id: true },
          }),
        )
      : [],
    category
      ? category === keyword
        ? keywordCategories
        : timeSearchRelation(timings, 'categoryFilter', () =>
            prisma.category.findMany({
              where: { name: contains(category) },
              select: { category_id: true },
            }),
          )
      : [],
    query.excludeApplied && user?.role === 'SEEKER'
      ? timeSearchRelation(timings, 'appliedJobs', () =>
          prisma.jobPostActivity.findMany({
            where: { seeker_id: user.sub },
            select: { job_post_id: true },
          }),
        )
      : [],
  ]);

  const where: Prisma.JobPostWhereInput = { is_active: true };
  const and: Prisma.JobPostWhereInput[] = [];
  if (keyword) {
    const or: Prisma.JobPostWhereInput[] = [
      { name: contains(keyword) },
      { job_title: contains(keyword) },
      { job_description: contains(keyword) },
      { candidate_requirements: contains(keyword) },
      { work_location: contains(keyword) },
    ];
    if (companies.length)
      or.push({ company_id: { in: companies.map((item) => item.company_id) } });
    if (categories.length)
      or.push({
        category_id: { in: categories.map((item) => item.category_id) },
      });
    if (types.length)
      or.push({ job_type_id: { in: types.map((item) => item.job_type_id) } });
    if (skillJobIds.length) or.push({ job_post_id: { in: skillJobIds } });
    and.push({ OR: or });
  }
  if (category) {
    where.category_id = { in: categoryFilter.map((item) => item.category_id) };
  }
  if (location) {
    and.push({
      OR: [
        { work_location: contains(location) },
        ...(cities.length
          ? [{ company_id: { in: cities.map((item) => item.company_id) } }]
          : []),
      ],
    });
  }
  if (applied.length) {
    where.job_post_id = { notIn: applied.map((item) => item.job_post_id) };
  }
  if (and.length) where.AND = and;
  return where;
}
