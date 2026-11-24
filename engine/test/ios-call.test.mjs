import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import IosCall, { LEASE_MS, NOTE, SAID_SOURCE, SOURCE, onCall, setCall } from '../plugins/ios-call/index.mjs';

/** A context that keeps the routes and the pre-step handler the plugin registers. */
function fakeContext() {
  const routes = new Map();
  const handlers = new Map();
  const disposers = [];
  const ctx = {
    effect: (run) => { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose); },
    on: (name, handler) => { handlers.set(name, handler); },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  };
  new IosCall(ctx);
  return { routes, preStep: handlers.get('agent/pre-step'), dispose: () => disposers.forEach((d) => d()) };
}

const state = (routes, body) => routes.get('/api/ios-call/state').fetch(
  new Request('http://x/api/ios-call/state', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
);

/** One pre-step pass for `sessionId` with the given proposal. */
const step = (preStep, sessionId, { number = 1, messages = [{ role: 'user', content: [] }], kind = 'proceed', aborted = false } = {}) =>
  preStep(
    { agent: { session: { id: sessionId } }, step: number, signal: { aborted } },
    async () => ({ kind, messages }),
  );

let dispose = () => {};
afterEach(() => dispose());

test('a session on a call gets the note after its messages, of its own source kind', async () => {
  const plugin = fakeContext();
  dispose = plugin.dispose;
  const response = await state(plugin.routes, { sessionId: 's1', active: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  const proposed = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }];
  const decision = await step(plugin.preStep, 's1', { messages: proposed });
  assert.equal(decision.messages.length, 2);
  assert.equal(decision.messages[0], proposed[0]);
  const note = decision.messages[1];
  assert.equal(note.role, 'user');
  assert.equal(note.source.kind, SOURCE);
  assert.equal(note.content[0].text, NOTE);
});

test('other sessions, later steps, retries and rejections are left alone', async () => {
  const plugin = fakeContext();
  dispose = plugin.dispose;
  await state(plugin.routes, { sessionId: 's1', active: true });
  assert.equal((await step(plugin.preStep, 's2')).messages.length, 1);
  assert.equal((await step(plugin.preStep, 's1', { number: 2 })).messages.length, 1);
  assert.equal((await step(plugin.preStep, 's1', { messages: [] })).messages.length, 0);
  assert.equal((await step(plugin.preStep, 's1', { kind: 'reject' })).messages.length, 1);
  assert.equal((await step(plugin.preStep, 's1', { aborted: true })).messages.length, 1);
});

test('hanging up ends the note at once', async () => {
  const plugin = fakeContext();
  dispose = plugin.dispose;
  await state(plugin.routes, { sessionId: 's1', active: true });
  await state(plugin.routes, { sessionId: 's1', active: false });
  assert.equal((await step(plugin.preStep, 's1')).messages.length, 1);
});

test('a call the app stopped renewing lapses', () => {
  setCall('s3', true, 1_000);
  assert.equal(onCall('s3', 1_000 + LEASE_MS - 1), true);
  setCall('s3', true, 50_000);
  assert.equal(onCall('s3', 1_000 + LEASE_MS + 1), true, 'renewing moves the lapse');
  assert.equal(onCall('s3', 50_000 + LEASE_MS), false);
  assert.equal(onCall('s3', 0), false, 'a lapsed call is forgotten');
});

test('a malformed request is refused', async () => {
  const plugin = fakeContext();
  dispose = plugin.dispose;
  assert.equal((await state(plugin.routes, 'not json')).status, 400);
  assert.equal((await state(plugin.routes, { sessionId: '', active: true })).status, 400);
  assert.equal((await state(plugin.routes, { sessionId: 's1' })).status, 400);
  assert.equal((await said(plugin.routes, 'not json')).status, 400);
  assert.equal((await said(plugin.routes, { sessionId: 's1', text: '  ' })).status, 400);
  assert.equal((await said(plugin.routes, { sessionId: 's1', text: 'x'.repeat(501) })).status, 400);
});

const said = (routes, body) => routes.get('/api/ios-call/said').fetch(
  new Request('http://x/api/ios-call/said', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
);

test('what the app said aloud between turns reaches the next turn, before the user\'s words', async () => {
  const plugin = fakeContext();
  dispose = plugin.dispose;
  await state(plugin.routes, { sessionId: 's1', active: true });
  const response = await said(plugin.routes, { sessionId: 's1', text: '还在吗？没声音的话我先挂了' });
  assert.equal(response.status, 200);
  await said(plugin.routes, { sessionId: 's1', text: '还在吗？' });

  const proposed = [{ role: 'user', content: [{ type: 'text', text: '在的' }] }];
  const decision = await step(plugin.preStep, 's1', { messages: proposed });
  assert.equal(decision.messages.length, 3);
  const [spoken, words, note] = decision.messages;
  assert.equal(spoken.role, 'user');
  assert.equal(spoken.source.kind, SAID_SOURCE);
  assert.match(spoken.content[0].text, /"还在吗？没声音的话我先挂了"\n"还在吗？"/);
  assert.equal(words, proposed[0]);
  assert.equal(note.source.kind, SOURCE);

  // Told once: the next turn has it in its history already.
  assert.equal((await step(plugin.preStep, 's1')).messages.length, 2);
});

test('what was said waits through later steps and retries, and goes with the call', async () => {
  const plugin = fakeContext();
  dispose = plugin.dispose;
  await state(plugin.routes, { sessionId: 's1', active: true });
  await said(plugin.routes, { sessionId: 's1', text: '还在吗？' });
  await step(plugin.preStep, 's1', { number: 2 });
  await step(plugin.preStep, 's1', { messages: [] });
  await step(plugin.preStep, 's1', { aborted: true });
  assert.equal((await step(plugin.preStep, 's2')).messages.length, 1, 'other sessions are left alone');
  assert.equal((await step(plugin.preStep, 's1')).messages[0].source.kind, SAID_SOURCE);

  // Hanging up after it: a turn typed later is not on that call and answers nothing.
  await said(plugin.routes, { sessionId: 's1', text: '还在吗？' });
  await state(plugin.routes, { sessionId: 's1', active: false });
  await state(plugin.routes, { sessionId: 's1', active: true });
  assert.equal((await step(plugin.preStep, 's1')).messages.length, 2);

  // Said when the call is already over: dropped.
  await state(plugin.routes, { sessionId: 's1', active: false });
  await said(plugin.routes, { sessionId: 's1', text: '还在吗？' });
  await state(plugin.routes, { sessionId: 's1', active: true });
  assert.equal((await step(plugin.preStep, 's1')).messages.length, 2);
});
