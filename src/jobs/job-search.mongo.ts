import type { Prisma } from '../generated/prisma/client.js';

const idFields = new Set([
  'job_post_id',
  'company_id',
  'category_id',
  'job_type_id',
]);
const textFields = new Set([
  'name',
  'job_title',
  'job_description',
  'candidate_requirements',
  'work_location',
]);

/** Compile only the scalar predicates produced by buildJobSearchWhere.
 * Unknown filters fail closed to the original Prisma path. No caller-supplied
 * Mongo operators or field names are accepted.
 */
export function compactJobSearchMatch(
  where: Prisma.JobPostWhereInput,
): Prisma.InputJsonObject | undefined {
  function compile(input: unknown): Prisma.InputJsonObject | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const output: Record<string, Prisma.InputJsonValue> = {};
    for (const [field, value] of Object.entries(input)) {
      if (field === 'AND' || field === 'OR') {
        if (!Array.isArray(value) || !value.length) return;
        const children = value.map(compile);
        if (children.some((child) => !child)) return;
        output[field === 'AND' ? '$and' : '$or'] =
          children as Prisma.InputJsonObject[];
      } else if (field === 'is_active' && value === true) {
        output.is_active = true;
      } else if (idFields.has(field)) {
        if (
          !value ||
          typeof value !== 'object' ||
          Object.keys(value).length !== 1
        )
          return;
        const [operator, members] = Object.entries(value)[0];
        if (
          !['in', 'notIn'].includes(operator) ||
          !Array.isArray(members) ||
          members.some((id) => !Number.isSafeInteger(id))
        )
          return;
        // Prisma's Int IDs may be stored as BSON int32 or int64. Mongo numeric
        // equality matches either representation; no lossy ID conversion occurs.
        output[field === 'job_post_id' ? '_id' : field] =
          operator === 'in'
            ? { $in: members }
            : { $nin: members, $exists: true };
      } else if (textFields.has(field)) {
        if (
          !value ||
          typeof value !== 'object' ||
          Object.keys(value).length !== 2 ||
          typeof value.contains !== 'string' ||
          value.mode !== 'insensitive'
        )
          return;
        // Captured Prisma 6.19.3 contains wraps the pattern with .* and does not
        // escape metacharacters. Preserve that exact existing behavior.
        output[field] = { $regex: `.*${value.contains}.*`, $options: 'i' };
      } else {
        return;
      }
    }
    return output;
  }
  return compile(where);
}

export function largeJobSearchMatch(where: Prisma.JobPostWhereInput) {
  // The measured regression is a ~1,943-ID skill branch expanded into thousands
  // of $expr equalities. Keep ordinary/small searches on their existing path:
  // compact selection adds a round trip and has not been justified for them.
  // 1,000 is a conservative scope guard, not a measured crossover point.
  const and = Array.isArray(where.AND) ? where.AND : [];
  const large = and.some((part) =>
    part.OR?.some((branch) => {
      const filter = branch.job_post_id;
      return (
        filter &&
        typeof filter === 'object' &&
        Array.isArray(filter.in) &&
        filter.in.length >= 1000
      );
    }),
  );
  return large ? compactJobSearchMatch(where) : undefined;
}

/** Raw aggregates return Extended JSON for BSON Long values on some engines. */
export function searchInteger(value: unknown): number {
  if (
    value &&
    typeof value === 'object' &&
    '$numberLong' in value &&
    (typeof value.$numberLong !== 'string' ||
      !/^-?\d+$/.test(value.$numberLong))
  )
    throw new Error('Invalid integer in job search aggregation');
  const candidate =
    value && typeof value === 'object' && '$numberLong' in value
      ? Number(value.$numberLong)
      : value;
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate))
    throw new Error('Invalid integer in job search aggregation');
  return candidate;
}
