import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import IosCall, {
  LEASE_MS, NOTE, SCREEN_BLIND, SCREEN_FRESH_MS, SCREEN_SAME, SCREEN_SHOT, SCREEN_SOURCE, SCREEN_STOPPED, SOURCE,
  onCall, setCall, setScreen, takeScreen,
} from '../plugins/ios-call/index.mjs';

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

/** A context whose model sees images when `sees`, with an attachment store that keeps what it saves. */
function screenContext({ sees = true } = {}) {
  const saved = [];
  const services = {
    llm: { resolveModelInfo: async () => ({ inputModalities: sees ? ['text', 'image'] : ['text'] }) },
    attachments: {
      saveImage: async (image) => {
        saved.push(image);
        return { attachmentId: `a${saved.length}`, mediaType: image.mediaType, bytes: image.data.length, width: 590, height: 1280 };
      },
    },
  };
  const routes = new Map();
  const handlers = new Map();
  const disposers = [];
  const ctx = {
    effect: (run) => { const d = run(); if (typeof d === 'function') disposers.push(d); },
    on: (name, handler) => { handlers.set(name, handler); },
    get: (name) => services[name],
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  };
  new IosCall(ctx);
  const preStep = handlers.get('agent/pre-step');
  return {
    routes,
    saved,
    dispose: () => disposers.forEach((d) => d()),
    turn: (sessionId) => preStep(
      { agent: { session: { id: sessionId }, options: { provider: 'p', model: 'm' } }, step: 1, signal: { aborted: false } },
      async () => ({ kind: 'proceed', messages: [{ role: 'user', content: [{ type: 'text', text: '看看这个' }] }] }),
    ),
  };
}

const screen = (routes, body) => routes.get('/api/ios-call/screen').fetch(
  new Request('http://x/api/ios-call/screen', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
);

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');

test('a shared screen goes with the next turn once, as a hidden screenshot', async () => {
  const plugin = screenContext();
  dispose = plugin.dispose;
  await state(plugin.routes, { sessionId: 's1', active: true });
  assert.equal((await screen(plugin.routes, { sessionId: 's1', state: 'shot', image: jpeg })).status, 200);

  const first = await plugin.turn('s1');
  assert.equal(first.messages.length, 3);
  const shot = first.messages[2];
  assert.equal(shot.source.kind, SCREEN_SOURCE);
  assert.equal(shot.content[0].text, SCREEN_SHOT);
  assert.deepEqual(shot.content[1], { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/jpeg', bytes: 7, width: 590, height: 1280 } });
  assert.equal(plugin.saved.length, 1);
  assert.deepEqual([...plugin.saved[0].data], [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  // Taken: the next turn without word from the app gets only the note.
  assert.equal((await plugin.turn('s1')).messages.length, 2);
});

test('an unchanged screen and a stop are said in a line', async () => {
  const plugin = screenContext();
  dispose = plugin.dispose;
  await state(plugin.routes, { sessionId: 's1', active: true });
  await screen(plugin.routes, { sessionId: 's1', state: 'same' });
  assert.equal((await plugin.turn('s1')).messages[2].content[0].text, SCREEN_SAME);
  await screen(plugin.routes, { sessionId: 's1', state: 'stopped' });
  const stopped = (await plugin.turn('s1')).messages[2];
  assert.equal(stopped.content.length, 1);
  assert.equal(stopped.content[0].text, SCREEN_STOPPED);
  assert.equal(plugin.saved.length, 0);
});

test('a model that cannot see images is told once, and nothing is stored', async () => {
  const plugin = screenContext({ sees: false });
  dispose = plugin.dispose;
  await state(plugin.routes, { sessionId: 's1', active: true });
  await screen(plugin.routes, { sessionId: 's1', state: 'shot', image: jpeg });
  assert.equal((await plugin.turn('s1')).messages[2].content[0].text, SCREEN_BLIND);
  await screen(plugin.routes, { sessionId: 's1', state: 'shot', image: jpeg });
  assert.equal((await plugin.turn('s1')).messages.length, 2);
  await screen(plugin.routes, { sessionId: 's1', state: 'same' });
  assert.equal((await plugin.turn('s1')).messages.length, 2);
  assert.equal(plugin.saved.length, 0);
});

test('a screen is not shown off a call, nor long after it was handed over', async () => {
  const plugin = screenContext();
  dispose = plugin.dispose;
  await screen(plugin.routes, { sessionId: 's1', state: 'shot', image: jpeg });
  assert.equal((await plugin.turn('s1')).messages.length, 1);

  setScreen('s2', { state: 'same' }, 1_000);
  assert.equal(takeScreen('s2', 1_000 + SCREEN_FRESH_MS + 1), undefined);
  setScreen('s2', { state: 'same' }, 1_000);
  assert.equal(takeScreen('s2', 1_000 + SCREEN_FRESH_MS).state, 'same');
});

test('hanging up drops a screen still waiting for a turn', async () => {
  const plugin = screenContext();
  dispose = plugin.dispose;
  await state(plugin.routes, { sessionId: 's1', active: true });
  await screen(plugin.routes, { sessionId: 's1', state: 'shot', image: jpeg });
  await state(plugin.routes, { sessionId: 's1', active: false });
  await state(plugin.routes, { sessionId: 's1', active: true });
  assert.equal((await plugin.turn('s1')).messages.length, 2);
});

test('a malformed screen is refused', async () => {
  const plugin = screenContext();
  dispose = plugin.dispose;
  assert.equal((await screen(plugin.routes, 'not json')).status, 400);
  assert.equal((await screen(plugin.routes, { sessionId: 's1', state: 'video' })).status, 400);
  assert.equal((await screen(plugin.routes, { sessionId: 's1', state: 'shot' })).status, 400);
  assert.equal((await screen(plugin.routes, { sessionId: 's1', state: 'shot', image: jpeg, mediaType: 'image/heic' })).status, 400);
});

test('a malformed request is refused', async () => {
  const plugin = fakeContext();
  dispose = plugin.dispose;
  assert.equal((await state(plugin.routes, 'not json')).status, 400);
  assert.equal((await state(plugin.routes, { sessionId: '', active: true })).status, 400);
  assert.equal((await state(plugin.routes, { sessionId: 's1' })).status, 400);
});
