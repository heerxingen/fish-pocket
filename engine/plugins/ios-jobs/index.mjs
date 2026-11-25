// Every live background job, whichever session owns it, for the app's 待办 tab and
// its background keeper. `job/list` only answers for one session at a time, and a
// dev server goes on long after the turn that started it, in a session nobody has open.
//
// GET /api/ios-jobs?after=<revision> answers `{revision, jobs}` at once when the set
// has moved past `after`, else when it next moves (or after WAIT_MS, unchanged): the
// app follows it in a loop, as a push. The revision moves when a job starts, stops or
// changes status; a progress line alone does not, it would wake the app for nothing.

const ROUTE = '/api/ios-jobs';
const WAIT_MS = 25_000;

const LIVE = new Set(['running', 'stopping']);

/** What the app shows of one job (`JobView`, without its output ring). */
function project(job) {
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    owner: job.owner,
    status: job.status,
    progress: job.progress,
    startedAt: job.startedAt,
  };
}

/** The live set, its revision, and the requests waiting for it to move. */
export function createJobBoard() {
  const live = new Map();
  const waiters = new Set();
  let revision = 0;
  const wake = () => {
    revision += 1;
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  return {
    /** One registry event (`JobEvent`). */
    apply(event) {
      if (event.type === 'output') return;
      const { job } = event;
      const known = live.get(job.id);
      if (event.type === 'settled' || event.type === 'removed' || !LIVE.has(job.status)) {
        if (live.delete(job.id)) wake();
        return;
      }
      live.set(job.id, project(job));
      if (known === undefined || known.status !== job.status) wake();
    },
    snapshot() {
      return { revision, jobs: [...live.values()] };
    },
    /**
     * Resolves once the revision is other than `after`, after `ms`, or when `signal` aborts.
     * A revision from before an engine restart is ahead of this one's: it answers at once too.
     */
    wait(after, signal, ms = WAIT_MS) {
      if (revision !== after) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        waiters.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    },
  };
}

export default class IosJobs {
  static inject = ['jobs', 'connection'];

  constructor(ctx) {
    const board = createJobBoard();
    ctx.effect(() => ctx.jobs.events.subscribe({ owners: 'all' }, (event) => board.apply(event)), 'ios-jobs: follow every job');
    ctx.effect(() => ctx.connection.fetch.register({
      path: ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const query = new URL(request.url).searchParams;
        const after = Number(query.get('after'));
        if (query.has('after') && Number.isInteger(after)) await board.wait(after, request.signal);
        return new Response(JSON.stringify(board.snapshot()), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      },
    }), 'ios-jobs: route');
  }
}
