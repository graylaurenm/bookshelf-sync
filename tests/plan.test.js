import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSteps, describePlan } from '../src/lib/plan.js';

test('read with date and rating: status, then finish date, then rating', () => {
  const item = { shelf: 'read', readAt: '2026-09-25', rating: 4 };
  assert.deepEqual(planSteps(item), [
    { op: 'setStatus', status: 'read' },
    { op: 'setFinishDate', date: '2026-09-25' },
    { op: 'createRating', stars: 4 },
  ]);
  assert.equal(describePlan(item), 'mark read, finished 2026-09-25, 4★');
});

test('read without date or rating only sets status', () => {
  assert.deepEqual(planSteps({ shelf: 'read', readAt: null, rating: 0 }), [{ op: 'setStatus', status: 'read' }]);
});

test('other shelves never write dates or ratings', () => {
  assert.deepEqual(planSteps({ shelf: 'to-read', readAt: '2026-01-01', rating: 5 }), [{ op: 'setStatus', status: 'to-read' }]);
  assert.equal(describePlan({ shelf: 'currently-reading', rating: 0 }), 'mark currently reading');
});
