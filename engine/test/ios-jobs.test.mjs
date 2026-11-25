import assert from 'node:assert/strict';
import { test } from 'node:test';
import IosJobs, { createJobBoard } from '../plugins/ios-jobs/index.mjs';

const job = (id, status = 'running', extra = {}) => ({ id, kind: 'bash', label: `npm run dev ${id}`, owner: 's1', status, startedAt: 1, ...extra });

test('the board holds live jobs of every owner and drops them once they settle', () => {
  const board = createJobBoard();
  board.apply({ type: 'registered', job: job('a') });
  board.apply({ type: 'registered', job: job('b', 'running', { owner: 's2' }) });
  assert.deepEqual(board.snapshot().jobs.map((j) => [j.id, j.owner]), [['a', 's1'], ['b', 's2']]);
  board.apply({ type: 'stopping', job: job('a', 'stopping') });
  assert.equal(board.snapshot().jobs[0].status, 'stopping');
  board.apply({ type: 'settled', job: job('a', 'completed'), cause: 'exit', awaited: false });
  board.apply({ type: 'removed', job: job('b') });
  assert.deepEqual(board.snapshot().jobs, []);
});

test('a progress line or output does not move the revision; a status change does', () => {
  const board = createJobBoard();
  board.apply({ type: 'registered', job: job('a') });
  const started = board.snapshot().revision;
  board.apply({ type: 'progress', job: job('a', 'running', { progress: 'compiled' }) });
  board.apply({ type: 'output', id: 'a', owner: 's1', total: 10 });
  assert.equal(board.snapshot().revision, started);
  assert.equal(board.snapshot().jobs[0].progress, 'compiled');
  board.apply({ type: 'stopping', job: job('a', 'stopping') });
  assert.equal(board.snapshot().revision, started + 1);
});

test('a wait answers at once for another revision, else on the next change', async () => {
  const board = createJobBoard();
  await board.wait(5, undefined, 10_000);
  let woke = false;
  const waiting = board.wait(0, undefined, 10_000).then(() => { woke = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(woke, false);
  board.apply({ type: 'registered', job: job('a') });
  await waiting;
  assert.equal(woke, true);
});

test('the route subscribes to every owner and answers the snapshot', async () => {
  const routes = new Map();
  let filter;
  let listener;
  const ctx = {
    effect: (run) => run(),
    jobs: { events: { subscribe: (f, l) => { filter = f; listener = l; return () => {}; } } },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } },
  };
  new IosJobs(ctx);
  assert.deepEqual(filter, { owners: 'all' });
  listener({ type: 'registered', job: job('a') });
  const route = routes.get('/api/ios-jobs');
  const first = await (await route.fetch(new Request('http://x/api/ios-jobs'))).json();
  assert.deepEqual(first, { revision: 1, jobs: [{ id: 'a', kind: 'bash', label: 'npm run dev a', owner: 's1', status: 'running', startedAt: 1 }] });
  const next = route.fetch(new Request('http://x/api/ios-jobs?after=1'));
  listener({ type: 'settled', job: job('a', 'completed'), cause: 'exit', awaited: false });
  assert.deepEqual(await (await next).json(), { revision: 2, jobs: [] });
});
