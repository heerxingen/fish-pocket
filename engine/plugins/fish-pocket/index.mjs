// The `fish-pocket` model route: DeepSeek models paid with Fish Pocket credits,
// over OpenAI Chat Completions through the Fish Pocket gateway. It is the third
// way to reach a model, beside the DeepSeek account and the user's own API keys,
// and it shares nothing with either.
//
// In particular it is not a profile in the `llm-pi-ai` settings, where the
// Models page keeps the user's own providers: a profile written there from the
// --patch overlay overrides that whole section, so the user's providers vanish
// and every write to it is refused. So this entry runs pi-ai's request code on
// its own, with a profile of its own, and keeps out of what `llm-pi-ai` owns: no
// settings form, no entry in the configurable-provider directory, no model
// discovery, no pi-ai sign-in flows. The stock `llm-pi-ai` entry still does all
// of those for the user's providers.
//
// The app passes the API origin as FISH_POCKET_API_URL and stores the runtime
// key after sign-in; without the key the route offers no models (and without the
// URL it points nowhere).
//
// The models come from the gateway's `GET /v1/models`, so a model the service
// starts offering appears without an app release, whoever makes it: each entry
// says how to shape its requests (`compat`, pi-ai's OpenAI Chat Completions
// switches) and which thinking levels it takes. The gateway is not
// api.deepseek.com, so pi-ai cannot detect DeepSeek's dialect (thinking.type,
// reasoning_content replay, max_tokens): an entry without `compat` gets it here.
//
// The last listing is kept in `<DSH_IOS_DATA>/fish-pocket-models.json` and used
// from the start, the built-in one until a listing ever arrives. The route reads
// the listing again when the catalog is asked for and its copy is an hour old
// (five minutes after a failed read) or the runtime key changed, and at once when
// a request names a model it does not know; a new listing tells the app through
// `llm/models-updated`. A failed read keeps the models it has.
import fs from 'node:fs';
import path from 'node:path';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';

export const name = 'fish-pocket';
export const inject = ['llm'];

export const ROUTE = 'fish-pocket';
export const KEY_REF = 'FISH_POCKET_RUNTIME_KEY';

/** How long a listing serves before the route reads it again. */
export const LISTING_MAX_AGE_MS = 60 * 60 * 1000;
/** How soon a failed read is tried again. */
export const LISTING_RETRY_MS = 5 * 60 * 1000;
const LISTING_TIMEOUT_MS = 15 * 1000;
const CACHE_FILE = 'fish-pocket-models.json';

/** How a listed model without `compat` is spoken to: DeepSeek's dialect. */
export const DEEPSEEK_COMPAT = {
  thinkingFormat: 'deepseek',
  maxTokensField: 'max_tokens',
  requiresReasoningContentOnAssistantMessages: true,
  supportsStore: false,
  supportsDeveloperRole: false,
};

/** The models until the gateway's listing arrives. */
export const BUILT_IN_MODELS = [{
  id: 'deepseek-flash',
  name: 'DeepSeek-V4.1-Flash',
  contextWindow: 1048576,
  maxTokens: 393216,
  input: ['text', 'image'],
  reasoningEfforts: { off: 'off', high: 'high' },
  compat: DEEPSEEK_COMPAT,
}];

const MODALITIES = new Set(['text', 'image']);
/** pi-ai's thinking levels, the ones a listing may offer. */
const LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const apiBase = (origin) => `${(origin || 'https://fish-pocket.invalid').replace(/\/+$/, '')}/v1`;

/** The route's pi-ai profile for the gateway at `origin` (FISH_POCKET_API_URL), serving `models`. */
export function profile(origin = process.env.FISH_POCKET_API_URL, models = BUILT_IN_MODELS) {
  return {
    displayName: 'Fish Pocket',
    apiKeyEnv: KEY_REF,
    api: 'openai-completions',
    baseURL: apiBase(origin),
    // Each model carries its own dialect (`compat`), which wins over the route's field by field.
    models: structuredClone(models),
  };
}

const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const listOf = (value, allowed) => Array.isArray(value) && value.length > 0 && value.every((item) => allowed.has(item))
  && new Set(value).size === value.length;

/**
 * pi-ai's `reasoningEfforts` for a listing's `reasoning_efforts`: a list of
 * levels sent as the same word, or a level → word map. Absent: the model does
 * not think (`false`). `undefined` when it is unusable.
 */
function effortsOf(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return listOf(value, LEVELS) ? Object.fromEntries(value.map((level) => [level, level])) : undefined;
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  const usable = entries.length > 0 && entries.every(([level, word]) => LEVELS.has(level)
    && (word === null || (typeof word === 'string' && word !== '')));
  return usable ? { ...value } : undefined;
}

/** Whether pi-ai's schema takes `model` on this route. */
function accepted(model) {
  try {
    PiAi.Config({ providers: { [ROUTE]: profile(undefined, [model]) } });
    return true;
  } catch {
    return false;
  }
}

/**
 * The pi-ai models a `GET /v1/models` body lists, in its order. An entry missing
 * a fact the route needs is left out; `undefined` when none is usable.
 */
export function modelsFromListing(body) {
  if (!Array.isArray(body?.data)) return undefined;
  const models = [];
  const seen = new Set();
  for (const entry of body.data) {
    const id = entry?.id;
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    if (!positiveInteger(entry.context_window) || !positiveInteger(entry.max_output_tokens)) continue;
    if (!listOf(entry.input_modalities, MODALITIES) || !entry.input_modalities.includes('text')) continue;
    const reasoningEfforts = effortsOf(entry.reasoning_efforts);
    if (reasoningEfforts === undefined) continue;
    if (entry.compat !== undefined && !isObject(entry.compat)) continue;
    const model = {
      id,
      name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name : id,
      contextWindow: entry.context_window,
      maxTokens: entry.max_output_tokens,
      input: [...entry.input_modalities],
      reasoningEfforts,
      compat: entry.compat === undefined ? DEEPSEEK_COMPAT : { ...entry.compat },
    };
    // A switch this build does not know, or a value pi-ai refuses, leaves this model out, not the listing.
    if (!accepted(model)) continue;
    seen.add(id);
    models.push(model);
  }
  return models.length > 0 ? models : undefined;
}

/** pi-ai's config for `models`; throws when its schema refuses the profile. */
const piAiConfig = (origin, models) => PiAi.Config({ providers: { [ROUTE]: profile(origin, models) } });

/**
 * The part of `ctx` pi-ai's `apply` may use here: the route's adapter goes to the
 * real LLM registry (through `wrap`), credentials and request hooks are read as
 * usual, and the things that belong to the `llm-pi-ai` entry are dropped.
 */
function routeOnly(ctx, wrap) {
  return {
    fiber: ctx.fiber,
    logger: ctx.logger,
    get: (service) => ctx.get(service),
    waterfall: (...args) => ctx.waterfall(...args),
    inject() {},
    on: () => () => {},
    llm: {
      registerAdapter: (routes, adapter) => ctx.llm.registerAdapter(routes, wrap(adapter)),
      registerConfigurableProviders: () => ({ replace() {}, dispose() {} }),
      registerModelDiscovery: () => () => {},
    },
  };
}

export function apply(ctx) {
  const origin = process.env.FISH_POCKET_API_URL;
  const cachePath = process.env.DSH_IOS_DATA ? path.join(process.env.DSH_IOS_DATA, CACHE_FILE) : undefined;

  let models = BUILT_IN_MODELS;
  let config = piAiConfig(origin, models);
  try {
    const cached = cachePath && JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    // A listing from another service (a test build's) does not apply here.
    if (cached?.base === apiBase(origin) && Array.isArray(cached.models)) {
      config = piAiConfig(origin, cached.models);
      models = cached.models;
    }
  } catch {
    // No listing kept yet, or an unreadable one: the built-in models serve.
  }

  // pi-ai reads its profiles through this on every operation, so replacing the
  // snapshot is all it takes to serve another set of models.
  let providers = config.providers.get();
  const adopt = (next) => {
    if (JSON.stringify(next) === JSON.stringify(models)) return;
    try {
      providers = piAiConfig(origin, next).providers.get();
    } catch (error) {
      ctx.logger.warn(`fish-pocket: model listing refused (${error?.message ?? error})`);
      return;
    }
    models = next;
    ctx.emit('llm/models-updated', ROUTE);
    if (!cachePath) return;
    try {
      fs.writeFileSync(`${cachePath}.tmp`, JSON.stringify({ base: apiBase(origin), models }));
      fs.renameSync(`${cachePath}.tmp`, cachePath);
    } catch (error) {
      ctx.logger.warn(`fish-pocket: could not keep the model listing (${error?.message ?? error})`);
    }
  };

  // When the listing is next due, and the key it was last read with: a new key
  // (signing in again, another account) reads it at once, whatever the last read gave.
  let due = 0;
  let readWith;
  let reading;
  const readListing = (now = false) => reading ??= (async () => {
    const key = (await ctx.get('credentials')?.resolve(KEY_REF))?.value;
    // Signed out: nothing to read with, and nothing to offer. Read on the next ask.
    if (!key) return;
    if (!now && key === readWith && Date.now() < due) return;
    readWith = key;
    try {
      const response = await fetch(`${apiBase(origin)}/models`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const listed = modelsFromListing(await response.json());
      if (!listed) throw new Error('no usable model in the listing');
      adopt(listed);
      due = Date.now() + LISTING_MAX_AGE_MS;
    } catch (error) {
      due = Date.now() + LISTING_RETRY_MS;
      ctx.logger.warn(`fish-pocket: could not read the model listing (${error?.message ?? error})`);
    }
  })().finally(() => { reading = undefined; });

  const wrap = (adapter) => new Proxy(adapter, {
    get(target, property) {
      if (property === 'listModels') {
        return (provider) => {
          void readListing();
          return target.listModels(provider);
        };
      }
      if (property === 'prepareCall') {
        return async (provider, model, ...rest) => {
          if (!models.some((entry) => entry.id === model)) await readListing(true);
          return target.prepareCall(provider, model, ...rest);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  PiAi.apply(routeOnly(ctx, wrap), { providers: { get: () => providers } });
}
