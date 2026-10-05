export function validateSchema(schema, value, path, errors, { stopOnInvalid = true } = {}) {
  const candidateMatches = (candidate) => {
    const found = [];
    validateSchema(candidate, value, path, found, { stopOnInvalid });
    return found.length === 0;
  };
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => candidateMatches(candidate));
    if (matches.length !== 1) errors.push(`${path} must match exactly one schema`);
    return;
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.filter((candidate) => candidateMatches(candidate));
    if (matches.length < 1) errors.push(`${path} must match at least one schema`);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
    if (stopOnInvalid) return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
    if (stopOnInvalid) return;
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${path} must be ${formatType(schema.type)}`);
    if (stopOnInvalid) return;
  }
  if (typeof value === 'string' && schema.minLength != null && value.length < schema.minLength) {
    errors.push(`${path} must have length >= ${schema.minLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateSchema(schema.items ?? {}, item, `${path}[${index}]`, errors, { stopOnInvalid }));
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validateSchema(childSchema, value[key], `${path}.${key}`, errors, { stopOnInvalid });
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
  }
}

function typeMatches(type, value) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    if (candidate === 'array') return Array.isArray(value);
    if (candidate === 'null') return value === null;
    if (candidate === 'integer') return Number.isInteger(value);
    if (candidate === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (candidate === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    return typeof value === candidate;
  });
}

function formatType(type) {
  return Array.isArray(type) ? type.join('|') : type;
}
