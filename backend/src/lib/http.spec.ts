import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { paginationParams } from '#src/lib/http.ts';

describe('paginationParams()', () => {
  it('applies defaults when nothing is supplied', () => {
    assert.deepEqual(paginationParams({}), { limit: 20, page: 0, offset: 0 });
  });

  it('derives the offset from page and limit', () => {
    assert.deepEqual(paginationParams({ limit: 10, page: 3 }), {
      limit: 10,
      page: 3,
      offset: 30,
    });
  });

  it('keeps page 0 at offset 0 for any limit', () => {
    assert.equal(paginationParams({ limit: 50, page: 0 }).offset, 0);
  });
});
