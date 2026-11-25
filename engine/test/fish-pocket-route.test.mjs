// The `fish-pocket` model route (plugins/fish-pocket): its own entry running
// pi-ai's OpenAI Chat Completions code against the Fish Pocket gateway, apart
// from the `llm-pi-ai` settings where the user's own providers live. Driven here
// against a local server standing in for the gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import * as FishPocket from '../plugins/fish-pocket/index.mjs';

const require = createRequire(import.meta.url);
const yaml = require(require.resolve('js-yaml', { paths: [require.resolve('@deepseek-ai/cordis-plugin-include')] }));
const overlay = yaml.load(fs.readFileSync(fileURLToPath(new URL('../ios.patch.yml', import.meta.url)), 'utf8'), { schema: entryListSchema });
const KEY = `fpk_${'a'.repeat(43)}`;
const REF = 'FISH_POCKET_RUNTIME_KEY';

/** Mount the route with FISH_POCKET_API_URL set to `api`; `seen` records what it registers and emits. */
async function mount(api, credentials, seen = {}, data = undefined) {
  const saved = process.env.FISH_POCKET_API_URL;
  const savedData = process.env.DSH_IOS_DATA;
  process.env.FISH_POCKET_API_URL = api;
  if (data) process.env.DSH_IOS_DATA = data;
  else delete process.env.DSH_IOS_DATA;
  const ctx = new Context();
  seen.updates = [];
  ctx.on('llm/models-updated', (provider) => seen.updates.push(provider));
  let adapter;
  ctx.provide('llm');
  ctx.provide('credentials');
  ctx.set('llm', {
    registerAdapter(routes, registered) {
      assert.deepEqual(routes, ['fish-pocket']);
      adapter = registered;
      return { replace() {}, dispose() {} };
    },
    registerConfigurableProviders: (entries) => {
      seen.directory = entries;
      return { replace() {}, dispose() {} };
    },
    registerModelDiscovery: (ns) => {
      seen.discovery = ns;
      return () => {};
    },
  });
  ctx.set('credentials', {
    resolve: async (ref) => (credentials.has(ref) ? { value: credentials.get(ref), source: 'store' } : undefined),
  });
  ctx.plugin(FishPocket);
  await new Promise((done) => setTimeout(done, 30));
  if (saved === undefined) delete process.env.FISH_POCKET_API_URL;
  else process.env.FISH_POCKET_API_URL = saved;
  if (savedData === undefined) delete process.env.DSH_IOS_DATA;
  else process.env.DSH_IOS_DATA = savedData;
  assert.ok(adapter, 'route registered');
  return adapter;
}

const FLASH = {
  id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4.1-Flash',
  context_window: 1048576, max_output_tokens: 393216, input_modalities: ['text', 'image'], reasoning_efforts: ['off', 'high'],
};
const PRO = {
  id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4-Pro',
  context_window: 1048576, max_output_tokens: 393216, input_modalities: ['text'], reasoning_efforts: ['off', 'high', 'max'],
};

/**
 * A stand-in gateway: records requests, answers `GET /v1/models` with `listing`
 * (a body, or a status to fail with) and chat completions with one streamed turn or an error.
 */
async function gateway(status = 200, listing = { object: 'list', data: [FLASH, PRO] }) {
  const requests = [];
  const listings = [];
  /** What the tests read and steer: `refuse()` answering true makes the listing a 401. */
  const state = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        listings.push({ headers: req.headers });
        const failed = typeof listing === 'number' || state.refuse?.() === true;
        res.writeHead(failed ? (typeof listing === 'number' ? listing : 401) : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(failed ? { error: { message: 'no' } } : listing));
        return;
      }
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Fish Pocket 余额不足，请充值后继续。(insufficient balance)', type: 'insufficient_balance', code: 'insufficient_balance' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = [
        { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking…' } }] },
        { choices: [{ index: 0, delta: { content: 'hello' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
      ];
      res.end(chunks.map((c) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'deepseek-flash', ...c })}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  state.requests = requests;
  state.listings = listings;
  state.api = `http://127.0.0.1:${server.address().port}`;
  state.close = () => server.close();
  return state;
}

const turn = (reasoningEffort, model = 'deepseek-flash') => ({
  provider: 'fish-pocket',
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  ...(reasoningEffort ? { reasoningEffort } : {}),
});

async function run(adapter, options) {
  const call = await adapter.prepareCall('fish-pocket', options.model);
  const events = [];
  for await (const event of call.stream(options)) events.push(event);
  return events;
}

test('the route points at FISH_POCKET_API_URL, and nowhere without it', () => {
  assert.equal(FishPocket.profile('https://api.example.test/').baseURL, 'https://api.example.test/v1');
  assert.equal(new URL(FishPocket.profile(undefined).baseURL).hostname, 'fish-pocket.invalid');
});

// Config for llm-pi-ai in the --patch overlay overrides the user's own providers
// (they vanish from the Models page) and every write to them is refused.
test('the overlay leaves the user\'s llm-pi-ai providers alone', () => {
  assert.equal(overlay.find((item) => item.id === 'llm-pi-ai'), undefined);
  assert.ok(overlay.some((item) => item.insert?.some((entry) => entry.id === 'fish-pocket')));
});

test('the route keeps out of the Models page directory and discovery', async () => {
  const seen = {};
  await mount('https://api.example.test', new Map(), seen);
  assert.equal(seen.directory, undefined);
  assert.equal(seen.discovery, undefined);
});

const settle = () => new Promise((done) => setTimeout(done, 50));
const ids = async (adapter) => (await adapter.listModels('fish-pocket')).map((m) => m.id);

test('models appear only once the runtime key is stored', async () => {
  const server = await gateway();
  try {
    const credentials = new Map();
    const adapter = await mount(server.api, credentials);
    assert.deepEqual(await adapter.listModels('fish-pocket'), []);
    await settle();
    assert.equal(server.listings.length, 0, 'no listing is read without a key');
    credentials.set(REF, KEY);
    // The built-in model serves until the listing arrives.
    assert.deepEqual(await ids(adapter), ['deepseek-flash']);
  } finally {
    server.close();
  }
});

test('the gateway\'s model listing replaces the built-in models and tells the app', async () => {
  const server = await gateway();
  try {
    const seen = {};
    const adapter = await mount(server.api, new Map([[REF, KEY]]), seen);
    await adapter.listModels('fish-pocket');
    await settle();
    assert.equal(server.listings[0].headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(seen.updates, ['fish-pocket']);
    const listed = await adapter.listModels('fish-pocket');
    assert.deepEqual(listed.map((m) => [m.id, m.name, m.inputModalities]), [
      ['deepseek-flash', 'DeepSeek-V4.1-Flash', ['text', 'image']],
      ['deepseek-v4-pro', 'DeepSeek-V4-Pro', ['text']],
    ]);
    // Fresh for an hour: asking again does not read it again.
    await settle();
    assert.equal(server.listings.length, 1);
    // A listed model takes requests, with the efforts the listing gave it.
    await run(adapter, turn('max', 'deepseek-v4-pro'));
    assert.equal(server.requests[0].body.model, 'deepseek-v4-pro');
    assert.deepEqual(server.requests[0].body.thinking, { type: 'enabled' });
  } finally {
    server.close();
  }
});

test('a new runtime key reads the listing at once, even right after a refused read', async () => {
  let accept = false;
  const server = await gateway();
  const credentials = new Map([[REF, KEY]]);
  try {
    const adapter = await mount(server.api, credentials);
    // The stand-in refuses the first key, as the gateway does a key from a deleted session.
    server.refuse = () => !accept;
    await adapter.listModels('fish-pocket');
    await settle();
    assert.deepEqual(await ids(adapter), ['deepseek-flash']);
    accept = true;
    credentials.set(REF, `fpk_${'b'.repeat(43)}`);
    await adapter.listModels('fish-pocket');
    await settle();
    assert.deepEqual(await ids(adapter), ['deepseek-flash', 'deepseek-v4-pro']);
  } finally {
    server.close();
  }
});

test('a request for a model the route does not know reads the listing first', async () => {
  const server = await gateway();
  try {
    const adapter = await mount(server.api, new Map([[REF, KEY]]));
    await run(adapter, turn('high', 'deepseek-v4-pro'));
    assert.equal(server.listings.length, 1);
    assert.equal(server.requests[0].body.model, 'deepseek-v4-pro');
  } finally {
    server.close();
  }
});

test('an unusable or failed listing keeps the models the route has', async () => {
  const broken = { object: 'list', data: [{ id: 'deepseek-next', name: 'Next' }, { ...PRO, input_modalities: ['image'] }] };
  for (const listing of [503, broken, { models: [] }]) {
    const server = await gateway(200, listing);
    try {
      const seen = {};
      const adapter = await mount(server.api, new Map([[REF, KEY]]), seen);
      await adapter.listModels('fish-pocket');
      await settle();
      assert.equal(server.listings.length, 1);
      assert.deepEqual(seen.updates, []);
      assert.deepEqual(await ids(adapter), ['deepseek-flash']);
    } finally {
      server.close();
    }
  }
});

test('another vendor\'s model is spoken to the way its entry says', async () => {
  const GPT = {
    id: 'gpt-x', object: 'model', owned_by: 'openai', name: 'GPT-X', context_window: 400000, max_output_tokens: 128000,
    input_modalities: ['text', 'image'], reasoning_efforts: { low: 'low', high: 'high', max: 'xhigh' },
    compat: { thinkingFormat: 'openai', maxTokensField: 'max_completion_tokens' },
  };
  const PLAIN = { id: 'plain', object: 'model', name: 'Plain', context_window: 32000, max_output_tokens: 8000, input_modalities: ['text'] };
  const server = await gateway(200, { object: 'list', data: [FLASH, GPT, PLAIN] });
  try {
    const adapter = await mount(server.api, new Map([[REF, KEY]]));
    await run(adapter, turn('max', 'gpt-x'));
    const [gpt] = server.requests;
    assert.equal(gpt.body.model, 'gpt-x');
    assert.equal(gpt.body.reasoning_effort, 'xhigh');
    assert.ok(!('thinking' in gpt.body), 'no DeepSeek thinking switch');
    assert.ok('max_completion_tokens' in gpt.body && !('max_tokens' in gpt.body));
    // The DeepSeek models keep their dialect beside it.
    await run(adapter, turn('high'));
    assert.deepEqual(server.requests[1].body.thinking, { type: 'enabled' });
    // A model that does not think offers no efforts.
    const plain = (await adapter.listModels('fish-pocket')).find((m) => m.id === 'plain');
    assert.ok(plain, 'listed');
    await run(adapter, turn(undefined, 'plain'));
    assert.equal(server.requests[2].body.model, 'plain');
  } finally {
    server.close();
  }
});

test('a model whose switches this build does not take stays out, and the others keep working', async () => {
  const odd = { ...PRO, id: 'odd-switch', compat: { notAPiAiSwitch: true } };
  const refused = { ...PRO, id: 'bad-value', compat: { thinkingFormat: 'nope' } };
  const server = await gateway(200, { object: 'list', data: [FLASH, odd, refused] });
  try {
    const adapter = await mount(server.api, new Map([[REF, KEY]]));
    await adapter.listModels('fish-pocket');
    await settle();
    const listed = await ids(adapter);
    assert.ok(!listed.includes('bad-value'));
    await run(adapter, turn('high'));
    assert.equal(server.requests.at(-1).body.model, 'deepseek-flash');
    if (listed.includes('odd-switch')) {
      await run(adapter, turn('high', 'odd-switch'));
      assert.equal(server.requests.at(-1).body.model, 'odd-switch');
    }
  } finally {
    server.close();
  }
});

test('entries missing a fact are left out of the listing', () => {
  const { context_window: _, ...noContext } = PRO;
  assert.deepEqual(FishPocket.modelsFromListing({ data: [FLASH, noContext, FLASH] }).map((m) => m.id), ['deepseek-flash']);
  assert.deepEqual(FishPocket.modelsFromListing({ data: [{ ...FLASH, name: '' }] })[0].name, 'deepseek-flash');
  assert.deepEqual(FishPocket.modelsFromListing({ data: [PRO] })[0].reasoningEfforts, { off: 'off', high: 'high', max: 'max' });
  assert.deepEqual(FishPocket.modelsFromListing({ data: [PRO] })[0].compat, FishPocket.DEEPSEEK_COMPAT);
  assert.equal(FishPocket.modelsFromListing({ data: [{ ...FLASH, reasoning_efforts: ['turbo'] }] }), undefined);
  assert.equal(FishPocket.modelsFromListing({ data: [{ ...FLASH, reasoning_efforts: { high: 3 } }] }), undefined);
  assert.equal(FishPocket.modelsFromListing({ data: [{ ...FLASH, compat: ['openai'] }] }), undefined);
  assert.equal(FishPocket.modelsFromListing(null), undefined);
});

test('the last listing serves from the next start, for the same service only', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-pocket-'));
  const server = await gateway();
  try {
    const first = await mount(server.api, new Map([[REF, KEY]]), {}, data);
    await first.listModels('fish-pocket');
    await settle();
    server.close();
    // Restarted with the gateway unreachable: the kept listing serves.
    const again = await mount(server.api, new Map([[REF, KEY]]), {}, data);
    assert.deepEqual(await ids(again), ['deepseek-flash', 'deepseek-v4-pro']);
    // Another service's build does not take it.
    const other = await mount('https://api.example.test', new Map([[REF, KEY]]), {}, data);
    assert.deepEqual(await ids(other), ['deepseek-flash']);
  } finally {
    server.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('chat completions go to the gateway with the runtime key and DeepSeek thinking switches', async () => {
  const server = await gateway();
  try {
    const adapter = await mount(server.api, new Map([[REF, KEY]]));
    const events = await run(adapter, turn('high'));
    await run(adapter, turn('off'));
    const [thinking, plain] = server.requests;
    assert.equal(thinking.url, '/v1/chat/completions');
    assert.equal(thinking.headers.authorization, `Bearer ${KEY}`);
    assert.equal(thinking.body.model, 'deepseek-flash');
    assert.equal(thinking.body.stream, true);
    assert.deepEqual(thinking.body.stream_options, { include_usage: true });
    assert.deepEqual(thinking.body.thinking, { type: 'enabled' });
    assert.ok('max_tokens' in thinking.body && !('max_completion_tokens' in thinking.body));
    assert.ok(!('store' in thinking.body));
    assert.deepEqual(plain.body.thinking, { type: 'disabled' });
    assert.ok(JSON.stringify(events).includes('hello'), 'answer reaches the harness');
  } finally {
    server.close();
  }
});

test('a 402 from the gateway ends the turn with QUOTA', async () => {
  const server = await gateway(402);
  try {
    const adapter = await mount(server.api, new Map([[REF, KEY]]));
    const finish = (await run(adapter, turn('off'))).find((event) => event.type === 'finish');
    assert.equal(finish.reason.kind, 'error');
    assert.equal(finish.reason.failure.code, 'QUOTA');
    // The app tells Fish Pocket's refusals apart by this name in the message.
    assert.match(finish.reason.failure.message, /Fish Pocket/);
  } finally {
    server.close();
  }
});
