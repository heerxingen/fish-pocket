// Voice calls from the app's call screen. The app does the listening and the speaking
// (Volcengine streaming recognition and synthesis, on the user's own key); the engine only
// needs to know that a session is on a call, so the model answers the way a call needs.
//
//   POST /api/ios-call/state   { sessionId, active }                    → { ok: true }
//   POST /api/ios-call/screen  { sessionId, state, image?, mediaType? }  → { ok: true }
//
// While a session is on a call, each turn's first step gets one note for the model, recorded
// like the time context: a user message of its own source kind, which the app's timeline never
// shows. The app renews the call every `RENEW_MS` and ends it on hang-up; a call the app stopped
// renewing (a crash, a lost connection) lapses after `LEASE_MS`, so no later turn is told it is
// on a call that is over.
//
// The user can share their phone's screen on a call (the app's broadcast extension captures it).
// Before each message it sends while sharing, the app hands over the screen as it is now
// (`state: 'shot'`), says it has not changed since the last one (`'same'`), or, once, that
// sharing stopped (`'stopped'`). The next turn's first step gets it as one more hidden message:
// the screenshot when the model can see images, a line saying it cannot otherwise.
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const ROUTE = '/api/ios-call';
/** The source kind of the note: the app's timeline shows only `user` messages. */
export const SOURCE = 'voice-call';
/** How long a call stays on without word from the app; the app renews it every 30 s. */
export const LEASE_MS = 90_000;

export const NOTE = 'The user is talking with you on a live voice call. Their words reach you through speech '
  + 'recognition, which can mishear a word or split one sentence into two messages: read them '
  + 'charitably, and ask when you cannot tell what they meant. Everything you write is read aloud '
  + 'as you write it, so answer in short, natural spoken sentences in the language the user speaks, '
  + 'without Markdown, lists, tables, code blocks, links or emoji. When something is better seen than '
  + 'heard (code, a long list, a '
  + 'table), say so in a sentence and keep it out of the answer. Say briefly what you are about to '
  + 'do before a long piece of work, so the user is not left in silence. The user can cut in at any '
  + 'time, which stops your answer where they started talking. If they want you to look at something '
  + 'on their phone, they can share their screen from the call screen; while they do, a screenshot of '
  + 'it comes with their messages.';

/** The source kind of what the shared screen adds to a turn. */
export const SCREEN_SOURCE = 'voice-call-screen';
/** A screen handed over longer ago than this went with a message that is long gone. */
export const SCREEN_FRESH_MS = 120_000;
/** No screenshot is anywhere near this large (the app sends a scaled-down JPEG). */
const MAX_SCREEN_BYTES = 8 * 1024 * 1024;
const SCREEN_TYPES = new Set(['image/jpeg', 'image/png']);

export const SCREEN_SHOT = 'The user is sharing their phone screen with you on this call. The image below is '
  + 'their screen as it was when they said the message above; look at it when what they say is about '
  + 'what they see. Earlier screenshots in this conversation show how the screen was then.';
export const SCREEN_SAME = 'The user is still sharing their screen; it has not changed since the last screenshot.';
export const SCREEN_STOPPED = 'The user has stopped sharing their screen. You no longer see it: earlier '
  + 'screenshots only show how it was then.';
export const SCREEN_BLIND = 'The user is sharing their phone screen on this call, but the model you are '
  + 'running on cannot look at images, so their screen does not reach you. If they talk about their '
  + 'screen, tell them briefly that you cannot see it, and that a model that can see images would.';

/** Session id → the time its call lapses. */
const calls = new Map();
/** Session id → the screen the app handed over for the next turn. */
const screens = new Map();
/** Sessions already told their model cannot see the screen being shared. */
const blind = new Set();

/** Whether `sessionId` is on a call at `now`. A lapsed call is forgotten. */
export function onCall(sessionId, now = Date.now()) {
  const until = calls.get(sessionId);
  if (until === undefined) return false;
  if (until > now) return true;
  calls.delete(sessionId);
  return false;
}

/** Start or renew (`active`) or end a session's call. */
export function setCall(sessionId, active, now = Date.now()) {
  if (active) {
    calls.set(sessionId, now + LEASE_MS);
  } else {
    calls.delete(sessionId);
    screens.delete(sessionId);
    blind.delete(sessionId);
  }
}

/**
 * What the app said of the shared screen before a message: `{ state: 'shot', data, mediaType }`,
 * `{ state: 'same' }` or `{ state: 'stopped' }`. Each replaces the one before; a turn takes it.
 */
export function setScreen(sessionId, screen, now = Date.now()) {
  screens.set(sessionId, { ...screen, at: now });
  if (screen.state === 'stopped') blind.delete(sessionId);
}

/** The screen for `sessionId`'s next turn, once; one handed over too long ago is dropped. */
export function takeScreen(sessionId, now = Date.now()) {
  const screen = screens.get(sessionId);
  screens.delete(sessionId);
  if (screen === undefined || now - screen.at > SCREEN_FRESH_MS) return undefined;
  return screen;
}

/** The note as a message of its own source kind. */
export function noteMessage() {
  return createUserMessage({
    content: [{ type: 'text', text: NOTE }],
    source: { kind: SOURCE, form: 'snapshot', sections: [{ name: SOURCE, text: NOTE }] },
  });
}

/** A hidden message of the shared screen's source kind, with the screenshot when there is one. */
function screenMessage(text, image) {
  return createUserMessage({
    content: image === undefined ? [{ type: 'text', text }] : [{ type: 'text', text }, { type: 'image', attachment: image }],
    source: { kind: SCREEN_SOURCE, form: 'snapshot', sections: [{ name: SCREEN_SOURCE, text }] },
  });
}

/**
 * Whether the model this turn runs on can look at images (the test the browser's screenshot
 * makes); undefined when it cannot be told.
 */
async function seesImages(ctx, agent, signal) {
  const routed = agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? agent?.options?.provider;
  const model = routed?.model ?? agent?.options?.model;
  const llm = ctx.get?.('llm');
  if (provider === undefined || model === undefined || llm === undefined) return undefined;
  try {
    const info = await llm.resolveModelInfo(provider, model, signal);
    return info?.inputModalities?.includes('image') === true;
  } catch {
    return undefined;
  }
}

/** What the turn is told of the shared screen, or undefined for nothing. */
async function describeScreen(ctx, agent, signal, screen) {
  const sessionId = agent.session.id;
  if (screen.state === 'stopped') return screenMessage(SCREEN_STOPPED);
  if (screen.state === 'same') return blind.has(sessionId) ? undefined : screenMessage(SCREEN_SAME);
  const sees = await seesImages(ctx, agent, signal);
  if (sees === false) {
    if (blind.has(sessionId)) return undefined;
    blind.add(sessionId);
    return screenMessage(SCREEN_BLIND);
  }
  // Not knowing the model, nothing is sent: an image it rejects would fail the whole turn.
  const attachments = ctx.get?.('attachments');
  if (sees !== true || attachments === undefined) return undefined;
  blind.delete(sessionId);
  try {
    const ref = await attachments.saveImage({ data: screen.data, mediaType: screen.mediaType, name: 'screen.jpg' });
    return screenMessage(SCREEN_SHOT, {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
    });
  } catch {
    // The message goes on without the screen rather than not at all.
    return undefined;
  }
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export default class IosCall {
  static inject = ['connection', 'agents'];

  constructor(ctx) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `${ROUTE}/state`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body;
        try { body = await request.json(); } catch { body = undefined; }
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
        if (!sessionId || typeof body?.active !== 'boolean') {
          return json({ error: { kind: 'invalid', message: 'expected { sessionId, active }' } }, 400);
        }
        setCall(sessionId, body.active);
        return json({ ok: true });
      },
    }), 'ios-call: state');

    ctx.effect(() => ctx.connection.fetch.register({
      path: `${ROUTE}/screen`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body;
        try { body = await request.json(); } catch { body = undefined; }
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
        const state = body?.state;
        if (!sessionId || !['shot', 'same', 'stopped'].includes(state)) {
          return json({ error: { kind: 'invalid', message: "expected { sessionId, state: 'shot' | 'same' | 'stopped' }" } }, 400);
        }
        if (state !== 'shot') {
          setScreen(sessionId, { state });
          return json({ ok: true });
        }
        const mediaType = body.mediaType ?? 'image/jpeg';
        const data = typeof body.image === 'string' ? Buffer.from(body.image, 'base64') : undefined;
        if (!SCREEN_TYPES.has(mediaType) || data === undefined || data.length === 0 || data.length > MAX_SCREEN_BYTES) {
          return json({ error: { kind: 'invalid', message: 'expected a JPEG or PNG screenshot in `image` (base64)' } }, 400);
        }
        setScreen(sessionId, { state, data, mediaType });
        return json({ ok: true });
      },
    }), 'ios-call: screen');

    // Only a turn's first step, and only one that brings new messages: the note is in the
    // history from then on, and a retry (no messages) already has it.
    ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal?.aborted || step !== 1 || decision.messages.length === 0) return decision;
      if (!onCall(agent.session.id)) return decision;
      const screen = takeScreen(agent.session.id);
      const shown = screen === undefined ? undefined : await describeScreen(ctx, agent, signal, screen);
      return { ...decision, messages: [...decision.messages, noteMessage(), ...(shown === undefined ? [] : [shown])] };
    });

    ctx.effect(() => () => {
      calls.clear();
      screens.clear();
      blind.clear();
    }, 'ios-call: calls');
  }
}
