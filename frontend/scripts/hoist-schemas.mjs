/**
 * Hoists inline schemas carrying a `title` into `components.schemas`, replacing
 * them with a `$ref`, so Orval names types `TaskResponse` instead of one alias
 * per operation (`CancelTask200`, `RetryTask200`, `ListTasks200Item`, …).
 *
 *   node scripts/hoist-schemas.mjs openapi.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? 'openapi.json';
const spec = JSON.parse(readFileSync(file, 'utf8'));
const components = spec.components?.schemas ?? {};
const seen = new Map();

// Fastify moves `description` out of querystring schemas into the parameter
// object, so the same schema arrives both with and without it.
function structure({ description: _d, example: _e, ...rest }) {
  return JSON.stringify(rest);
}

function hoist(node) {
  if (Array.isArray(node)) return node.map(hoist);
  if (node === null || typeof node !== 'object') return node;

  const walked = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, hoist(v)]));
  const { title } = walked;
  if (typeof title !== 'string' || walked.$ref) return walked;

  const existing = seen.get(title);
  if (existing && structure(existing) !== structure(walked)) {
    throw new Error(`Two different schemas are both titled "${title}"; titles become type names.`);
  }

  const richest =
    existing && Object.keys(existing).length > Object.keys(walked).length ? existing : walked;
  seen.set(title, richest);
  components[title] = richest;
  return { $ref: `#/components/schemas/${title}` };
}

spec.paths = hoist(spec.paths);
spec.components = { ...spec.components, schemas: components };

writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`Hoisted ${seen.size}: ${[...seen.keys()].sort().join(', ')}`);
