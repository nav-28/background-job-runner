import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ParamDescriptor, WorkerDescriptor, WorkerResult } from '#src/engine/types.ts';
import { createWorkerRegistry } from '#src/engine/workers/registry.ts';
import { BadRequestError } from '#src/lib/errors.ts';

/**
 * Parameter validation is the engine's input guard: it is what the HTTP layer will lean on to
 * reject a bad `POST /tasks` body, and what `lanes()` describes so a client can render a form.
 * It touches no database, so it is a unit test — `pnpm test`, no Postgres required.
 */

const handler = async (): Promise<WorkerResult> => ({ status: 'ready' });

const lane = (name: string, params: ParamDescriptor[] = []): WorkerDescriptor => ({
  lane: name,
  kind: 'inline',
  handler,
  params,
  description: `Test lane ${name}`,
});

const duration: ParamDescriptor = {
  name: 'duration_ms',
  type: 'number',
  required: false,
  min: 1,
  max: 300_000,
};
const fail: ParamDescriptor = { name: 'fail', type: 'boolean', required: false, default: false };
const url: ParamDescriptor = { name: 'url', type: 'string', required: true };

describe('worker registry', () => {
  describe('lookup', () => {
    it('names the lanes it knows when asked for one it does not', () => {
      const registry = createWorkerRegistry([lane('scrape'), lane('report')]);

      assert.equal(registry.has('scrape'), true);
      assert.equal(registry.has('convert'), false);
      assert.throws(() => registry.get('convert'), BadRequestError);
      assert.throws(() => registry.get('convert'), /Known lanes: report, scrape/);
    });

    it('describes its lanes without leaking the handler', () => {
      const registry = createWorkerRegistry([lane('scrape', [duration])]);
      const [info] = registry.list();

      assert.equal(info.lane, 'scrape');
      assert.deepEqual(info.params, [duration]);
      assert.equal('handler' in info, false, 'a lane description is data, not code');
    });
  });

  describe('validateParams', () => {
    it('rejects an unknown lane before looking at the params', () => {
      const registry = createWorkerRegistry([lane('scrape')]);

      assert.throws(() => registry.validateParams('nope', {}), BadRequestError);
    });

    it('coerces numeric strings, because query strings have no number type', () => {
      const registry = createWorkerRegistry([lane('scrape', [duration])]);

      assert.deepEqual(registry.validateParams('scrape', { duration_ms: 500 }), {
        duration_ms: 500,
      });
      assert.deepEqual(registry.validateParams('scrape', { duration_ms: '500' }), {
        duration_ms: 500,
      });
    });

    it('rejects values that are not really numbers', () => {
      const registry = createWorkerRegistry([lane('scrape', [duration])]);

      for (const bad of ['abc', '', true, false, Number.POSITIVE_INFINITY, Number.NaN, {}]) {
        assert.throws(
          () => registry.validateParams('scrape', { duration_ms: bad }),
          BadRequestError,
          `expected ${JSON.stringify(bad)} to be rejected`,
        );
      }
    });

    it('enforces the declared bounds', () => {
      const registry = createWorkerRegistry([lane('scrape', [duration])]);

      assert.throws(() => registry.validateParams('scrape', { duration_ms: 0 }), /must be >= 1/);
      assert.throws(
        () => registry.validateParams('scrape', { duration_ms: 300_001 }),
        /must be <= 300000/,
      );
      // The bounds are inclusive.
      assert.deepEqual(registry.validateParams('scrape', { duration_ms: 1 }), { duration_ms: 1 });
      assert.deepEqual(registry.validateParams('scrape', { duration_ms: 300_000 }), {
        duration_ms: 300_000,
      });
    });

    it('accepts booleans and their string spellings, and nothing else', () => {
      const registry = createWorkerRegistry([lane('scrape', [fail])]);

      assert.deepEqual(registry.validateParams('scrape', { fail: true }), { fail: true });
      assert.deepEqual(registry.validateParams('scrape', { fail: 'true' }), { fail: true });
      assert.deepEqual(registry.validateParams('scrape', { fail: 'false' }), { fail: false });

      for (const bad of ['yes', '1', 1, 0]) {
        assert.throws(
          () => registry.validateParams('scrape', { fail: bad }),
          BadRequestError,
          `expected ${JSON.stringify(bad)} to be rejected`,
        );
      }
    });

    it('does not accept a non-string where a string was declared', () => {
      const registry = createWorkerRegistry([lane('fetch', [url])]);

      assert.deepEqual(registry.validateParams('fetch', { url: 'https://example.com' }), {
        url: 'https://example.com',
      });
      assert.throws(() => registry.validateParams('fetch', { url: 42 }), BadRequestError);
    });

    it('demands a required param and names it', () => {
      const registry = createWorkerRegistry([lane('fetch', [url])]);

      assert.throws(() => registry.validateParams('fetch', {}), BadRequestError);
      assert.throws(() => registry.validateParams('fetch', {}), /requires parameter "url"/);
      // null is absence, not a value to coerce.
      assert.throws(() => registry.validateParams('fetch', { url: null }), /requires parameter/);
    });

    it('fills in a declared default and drops an absent optional', () => {
      const registry = createWorkerRegistry([lane('scrape', [duration, fail])]);

      // `fail` has a default and appears; `duration_ms` has none and is omitted entirely rather
      // than set to undefined, so the worker sees the same shape either way.
      assert.deepEqual(registry.validateParams('scrape', {}), { fail: false });
    });

    it('passes undeclared params through untouched', () => {
      const registry = createWorkerRegistry([lane('scrape', [duration])]);

      // Deliberate: `params` is a jsonb column and callers hang their own metadata there. Only
      // declared params are validated strictly.
      assert.deepEqual(
        registry.validateParams('scrape', { duration_ms: 10, note: { nested: ['x'] } }),
        { duration_ms: 10, note: { nested: ['x'] } },
      );
    });

    it('does not mutate the params it was handed', () => {
      const registry = createWorkerRegistry([lane('scrape', [fail])]);
      const input = {};

      registry.validateParams('scrape', input);

      assert.deepEqual(input, {}, 'the default landed on a copy, not on the caller’s object');
    });
  });
});
