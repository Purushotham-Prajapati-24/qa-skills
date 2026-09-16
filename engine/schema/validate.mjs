/**
 * A deliberately small JSON Schema validator (draft-07 subset), zero dependencies.
 *
 * Why not Ajv? This package must run with no `npm install` step, offline, on a
 * machine where the only guarantee is a Node runtime. The cost is that we
 * support a subset of draft-07 -- which is stated explicitly in
 * docs/assumptions.md so nobody writes a schema keyword that is silently ignored.
 *
 * Supported: $ref (local "#/definitions/x" and "file.schema.json#/definitions/x"),
 *   type, enum, const, required, properties, patternProperties,
 *   additionalProperties, items (schema or tuple), minItems, maxItems,
 *   uniqueItems, minimum, maximum, exclusiveMinimum, exclusiveMaximum,
 *   multipleOf, minLength, maxLength, pattern, format (date-time|date|uri|email),
 *   allOf, anyOf, oneOf, not, dependentRequired, nullable.
 *
 * Unsupported keywords cause a hard error at schema-load time (see assertKnown)
 * rather than passing silently. That is the important property.
 */
import path from 'node:path';
import { readJson } from '../core/fsjson.mjs';
import { schemaPath } from '../core/paths.mjs';

const KNOWN = new Set([
  '$schema', '$id', '$ref', '$comment', 'title', 'description', 'default', 'examples',
  'definitions', 'type', 'enum', 'const', 'required', 'properties', 'patternProperties',
  'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minimum',
  'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength',
  'maxLength', 'pattern', 'format', 'allOf', 'anyOf', 'oneOf', 'not',
  'dependentRequired', 'nullable',
]);

const FORMATS = {
  'date-time': /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  uri: /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
};

const cache = new Map();

/** Load a schema by bare name, e.g. loadSchema('decision'). */
export function loadSchema(name) {
  if (cache.has(name)) return cache.get(name);
  const file = schemaPath(name);
  const schema = readJson(file);
  assertKnown(schema, `${name}.schema.json`);
  cache.set(name, schema);
  return schema;
}

/** Keywords whose value is a map of {name -> schema}. */
const SCHEMA_MAPS = ['properties', 'patternProperties', 'definitions'];
/** Keywords whose value is a list of schemas. */
const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf'];

/**
 * Walk a schema and reject any keyword this validator does not implement.
 * A silently-ignored keyword is worse than a crash: it makes a schema look
 * stricter than it is.
 */
function assertKnown(node, where, at = '#') {
  if (typeof node === 'boolean' || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((n, i) => assertKnown(n, where, `${at}/${i}`));
    return;
  }
  for (const key of Object.keys(node)) {
    if (!KNOWN.has(key)) {
      throw new Error(`Unsupported JSON Schema keyword "${key}" at ${at} in ${where}`);
    }
  }
  for (const mapKey of SCHEMA_MAPS) {
    for (const [name, sub] of Object.entries(node[mapKey] ?? {})) {
      assertKnown(sub, where, `${at}/${mapKey}/${name}`);
    }
  }
  for (const listKey of SCHEMA_LISTS) {
    (node[listKey] ?? []).forEach((sub, i) => assertKnown(sub, where, `${at}/${listKey}/${i}`));
  }
  if (node.items) assertKnown(node.items, where, `${at}/items`);
  if (node.not) assertKnown(node.not, where, `${at}/not`);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    assertKnown(node.additionalProperties, where, `${at}/additionalProperties`);
  }
}

function resolveRef(ref, rootSchema, rootName) {
  const [filePart, pointer] = ref.split('#');
  let base = rootSchema;
  let baseName = rootName;
  if (filePart) {
    baseName = path.basename(filePart).replace(/\.schema\.json$/, '');
    base = loadSchema(baseName);
  }
  if (!pointer || pointer === '/') return { schema: base, rootSchema: base, rootName: baseName };
  const parts = pointer.split('/').filter(Boolean).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = base;
  for (const part of parts) {
    cur = cur?.[part];
    if (cur === undefined) throw new Error(`Unresolvable $ref: ${ref}`);
  }
  return { schema: cur, rootSchema: base, rootName: baseName };
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, want) {
  const actual = typeOf(value);
  if (want === 'number') return actual === 'number' || actual === 'integer';
  if (want === 'integer') return actual === 'integer';
  return actual === want;
}

function check(value, schema, ctx, at, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push({ path: at, message: 'schema is false: nothing is valid here' });
    return;
  }
  if (schema.$ref) {
    const r = resolveRef(schema.$ref, ctx.rootSchema, ctx.rootName);
    check(value, r.schema, { rootSchema: r.rootSchema, rootName: r.rootName }, at, errors);
    return;
  }
  if (schema.nullable === true && value === null) return;

  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wanted.some((t) => matchesType(value, t))) {
      errors.push({ path: at, message: `expected type ${wanted.join('|')}, got ${typeOf(value)}` });
      return; // further keyword checks would be noise
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push({ path: at, message: `value ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]` });
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push({ path: at, message: `expected const ${JSON.stringify(schema.const)}` });
  }

  const t = typeOf(value);

  if (t === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push({ path: at, message: `shorter than minLength ${schema.minLength}` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push({ path: at, message: `longer than maxLength ${schema.maxLength}` });
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      errors.push({ path: at, message: `does not match pattern ${schema.pattern}` });
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format].test(value))
      errors.push({ path: at, message: `not a valid ${schema.format}` });
  }

  if (t === 'number' || t === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push({ path: at, message: `below minimum ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push({ path: at, message: `above maximum ${schema.maximum}` });
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
      errors.push({ path: at, message: `not > ${schema.exclusiveMinimum}` });
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)
      errors.push({ path: at, message: `not < ${schema.exclusiveMaximum}` });
    if (schema.multipleOf !== undefined && Math.abs(value % schema.multipleOf) > 1e-9)
      errors.push({ path: at, message: `not a multiple of ${schema.multipleOf}` });
  }

  if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push({ path: at, message: `fewer than minItems ${schema.minItems}` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push({ path: at, message: `more than maxItems ${schema.maxItems}` });
    if (schema.uniqueItems) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) errors.push({ path: at, message: 'items are not unique' });
    }
    if (Array.isArray(schema.items)) {
      schema.items.forEach((s, i) => {
        if (i < value.length) check(value[i], s, ctx, `${at}/${i}`, errors);
      });
    } else if (schema.items) {
      value.forEach((v, i) => check(v, schema.items, ctx, `${at}/${i}`, errors));
    }
  }

  if (t === 'object') {
    for (const key of schema.required ?? []) {
      // `undefined` counts as absent: JSON serialisation drops it, so treating
      // it as present would let a record validate now and fail on reload.
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined)
        errors.push({ path: at, message: `missing required property "${key}"` });
    }
    for (const [key, need] of Object.entries(schema.dependentRequired ?? {})) {
      if (key in value) {
        for (const dep of need) {
          if (!(dep in value))
            errors.push({ path: at, message: `"${key}" present so "${dep}" is required` });
        }
      }
    }
    const props = schema.properties ?? {};
    const patternProps = Object.entries(schema.patternProperties ?? {});
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue; // absent once serialised
      let handled = false;
      if (props[key]) {
        check(v, props[key], ctx, `${at}/${key}`, errors);
        handled = true;
      }
      for (const [pattern, sub] of patternProps) {
        if (new RegExp(pattern).test(key)) {
          check(v, sub, ctx, `${at}/${key}`, errors);
          handled = true;
        }
      }
      if (!handled && schema.additionalProperties === false) {
        errors.push({ path: at, message: `unexpected property "${key}"` });
      } else if (!handled && typeof schema.additionalProperties === 'object') {
        check(v, schema.additionalProperties, ctx, `${at}/${key}`, errors);
      }
    }
  }

  for (const sub of schema.allOf ?? []) check(value, sub, ctx, at, errors);

  if (schema.anyOf) {
    const ok = schema.anyOf.some((sub) => {
      const local = [];
      check(value, sub, ctx, at, local);
      return local.length === 0;
    });
    if (!ok) errors.push({ path: at, message: 'does not match any schema in anyOf' });
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub) => {
      const local = [];
      check(value, sub, ctx, at, local);
      return local.length === 0;
    }).length;
    if (matches !== 1)
      errors.push({ path: at, message: `matched ${matches} schemas in oneOf, expected exactly 1` });
  }

  if (schema.not) {
    const local = [];
    check(value, schema.not, ctx, at, local);
    if (local.length === 0) errors.push({ path: at, message: 'matched a schema it must not match' });
  }
}

/**
 * Validate `value` against the named schema.
 * @returns {{valid: boolean, errors: Array<{path: string, message: string}>}}
 */
export function validate(value, schemaName) {
  const schema = loadSchema(schemaName);
  const errors = [];
  check(value, schema, { rootSchema: schema, rootName: schemaName }, '#', errors);
  return { valid: errors.length === 0, errors };
}

/** Throw on invalid. Used everywhere a record is about to be persisted. */
export function assertValid(value, schemaName) {
  const { valid, errors } = validate(value, schemaName);
  if (!valid) {
    const detail = errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
    throw new Error(`Schema validation failed for "${schemaName}":\n${detail}`);
  }
  return value;
}
