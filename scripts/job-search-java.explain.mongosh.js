// Load into an already authenticated mongosh session. Loading performs NO reads.
// Every exported operation is read-only; no profiling, index or data changes.
// Logical equivalents for q=Java&page=1&limit=10, not captured Prisma wire commands.
globalThis.jobSearchJava = (() => {
  let databaseName;
  let maxTimeMS = 5000;
  let resolved;
  const regex = { $regex: 'Java', $options: 'i' };
  const projection = {
    _id: 1,
    name: 1,
    job_title: 1,
    job_description: 1,
    candidate_requirements: 1,
    work_location: 1,
    work_type: 1,
    level: 1,
    salary: 1,
    is_active: 1,
    created_date: 1,
    company_id: 1,
    category_id: 1,
    job_type_id: 1,
  };

  function uniqueIds(values) {
    // BSON Long instances with equal values have different object identities.
    // Decimal strings retain all 64 bits; Number(value) can silently merge IDs.
    // Keep the first original BSON value for subsequent $in comparisons.
    const byValue = new Map();
    for (const value of values) {
      const key = value.toString();
      if (!byValue.has(key)) byValue.set(key, value);
    }
    return [...byValue.values()];
  }

  function check() {
    if (!databaseName || db.getName() !== databaseName)
      throw Error(
        'Configure the approved database name first; database context must not change',
      );
  }

  function mode(value) {
    if (!['queryPlanner', 'executionStats'].includes(value))
      throw Error('Use queryPlanner or explicitly request executionStats');
    return value;
  }

  function aggregatePlan(collection, pipeline, verbosity) {
    check();
    return db
      .getCollection(collection)
      .explain(mode(verbosity))
      .aggregate(pipeline, { maxTimeMS });
  }

  function findPlan(collection, filter, select, verbosity) {
    check();
    return db
      .getCollection(collection)
      .find(filter, select)
      .maxTimeMS(maxTimeMS)
      .explain(mode(verbosity));
  }

  function match() {
    check();
    if (!resolved)
      throw Error('Call resolve() once to obtain related IDs first');
    const or = [
      'name',
      'job_title',
      'job_description',
      'candidate_requirements',
      'work_location',
    ].map((field) => ({ [field]: regex }));
    if (resolved.companies.length)
      or.push({ company_id: { $in: resolved.companies } });
    if (resolved.categories.length)
      or.push({ category_id: { $in: resolved.categories } });
    if (resolved.types.length)
      or.push({ job_type_id: { $in: resolved.types } });
    if (resolved.jobs.length) or.push({ _id: { $in: resolved.jobs } });
    return { is_active: true, $and: [{ $or: or }] };
  }

  function pagePipeline() {
    return [
      { $match: match() },
      { $sort: { created_date: -1, _id: -1 } },
      { $skip: 0 },
      { $limit: 10 },
      { $project: projection },
    ];
  }

  return Object.freeze({
    configure(options) {
      if (
        !options ||
        typeof options.databaseName !== 'string' ||
        !options.databaseName
      )
        throw Error('An explicit approved databaseName is required');
      const budget = options.maxTimeMS ?? 5000;
      if (!Number.isInteger(budget) || budget < 1 || budget > 10000)
        throw Error('maxTimeMS must be an integer between 1 and 10000');
      if (db.getName() !== options.databaseName)
        throw Error('Database name does not match this session');
      databaseName = options.databaseName;
      maxTimeMS = budget;
      resolved = undefined;
    },

    indexes() {
      check();
      return Object.fromEntries(
        [
          'JobPost',
          'Company',
          'Category',
          'JobType',
          'Skill',
          'JobPostSkill',
          'JobPostActivity',
        ].map((name) => [name, db.getCollection(name).getIndexes()]),
      );
    },

    resolve() {
      check();
      const ids = (collection, field) =>
        db
          .getCollection(collection)
          .find({ [field]: regex }, { _id: 1 })
          .maxTimeMS(maxTimeMS)
          .toArray()
          .map((row) => row._id);
      // Sequential, bounded diagnostic reads, deliberately not a load generator.
      const companies = ids('Company', 'company_name');
      const categories = ids('Category', 'name');
      const types = ids('JobType', 'job_type');
      const skills = ids('Skill', 'skill_name');
      const jobs = skills.length
        ? uniqueIds(
            db
              .getCollection('JobPostSkill')
              .find({ skill_id: { $in: skills } }, { _id: 0, job_post_id: 1 })
              .maxTimeMS(maxTimeMS)
              .toArray()
              .map((row) => row.job_post_id),
          )
        : [];
      resolved = { companies, categories, types, skills, jobs };
      return Object.fromEntries(
        Object.entries(resolved).map(([name, values]) => [name, values.length]),
      );
    },

    relationPlans(verbosity = 'queryPlanner') {
      check();
      const plans = [
        ['Company', 'company_name'],
        ['Category', 'name'],
        ['JobType', 'job_type'],
        ['Skill', 'skill_name'],
      ].map(([collection, field]) => ({
        collection,
        plan: findPlan(collection, { [field]: regex }, { _id: 1 }, verbosity),
      }));
      if (resolved?.skills.length)
        plans.push({
          collection: 'JobPostSkill',
          plan: findPlan(
            'JobPostSkill',
            { skill_id: { $in: resolved.skills } },
            { _id: 0, job_post_id: 1 },
            verbosity,
          ),
        });
      return plans;
    },

    pageSelectionPlan(verbosity = 'queryPlanner') {
      return aggregatePlan('JobPost', pagePipeline(), verbosity);
    },

    pageWithRelationsPlan(verbosity = 'queryPlanner') {
      // Control pipeline: relation loading after page selection. Prisma's emitted
      // lookup/projection ordering may differ; compare actual plans separately.
      return aggregatePlan(
        'JobPost',
        [
          ...pagePipeline(),
          {
            $lookup: {
              from: 'Company',
              localField: 'company_id',
              foreignField: '_id',
              as: 'Company',
              pipeline: [{ $project: { _id: 1, company_name: 1, city: 1 } }],
            },
          },
          {
            $lookup: {
              from: 'Category',
              localField: 'category_id',
              foreignField: '_id',
              as: 'Category',
              pipeline: [{ $project: { _id: 1, name: 1 } }],
            },
          },
          {
            $lookup: {
              from: 'JobType',
              localField: 'job_type_id',
              foreignField: '_id',
              as: 'JobType',
              pipeline: [{ $project: { _id: 1, job_type: 1 } }],
            },
          },
          {
            $lookup: {
              from: 'JobPostSkill',
              localField: '_id',
              foreignField: 'job_post_id',
              as: 'JobPostSkill',
              pipeline: [
                { $limit: 10 },
                { $project: { _id: 0, skill_id: 1 } },
                {
                  $lookup: {
                    from: 'Skill',
                    localField: 'skill_id',
                    foreignField: '_id',
                    as: 'Skill',
                    pipeline: [{ $project: { _id: 0, skill_name: 1 } }],
                  },
                },
              ],
            },
          },
        ],
        verbosity,
      );
    },

    countPlan(verbosity = 'queryPlanner') {
      return aggregatePlan(
        'JobPost',
        [{ $match: match() }, { $count: 'total' }],
        verbosity,
      );
    },
  });
})();
