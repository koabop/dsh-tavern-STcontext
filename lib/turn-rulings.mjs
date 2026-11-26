import { createHash, randomUUID } from 'node:crypto';

// Host foregroundRequestContext() projects both turn sections as plugin current-state
// contributions. collectSections() qualifies the dice registration name, whereas the
// host's own projectPluginTurnContext() appends the damper directly after the dice shift.
const sources = [
  { setting: 'injectNarrativeDamper', key: 'narrativeDamper', plugin: 'dsh-tavern', name: 'narrative-damper' },
  { setting: 'injectFateDice', key: 'fateDice', plugin: 'dsh-tavern-fate-dice', name: 'tavern-plugin:dsh-tavern-fate-dice:fate-dice' },
];
const validTurn = turn => Number.isSafeInteger(turn) && turn > 0;
const rawDigest = text => createHash('sha256').update(text, 'utf16le').digest('hex');
const unverified = { warning: '无法核对本轮宿主请求帧，已跳过动态裁定。' };

function selectSections(frame, enabled) {
  const turnRulings = {};
  let ambiguous = false;
  for (const { key, plugin, name } of enabled) {
    const fields = Object.entries({ slot: 'currentStateProjection', origin: 'plugin', plugin, name });
    // A definite mismatch excludes the section regardless of its prose. A partial
    // identity cannot establish either presence or absence of this particular source.
    const possible = frame.sections.filter(section => fields.every(([k, v]) =>
      typeof section?.[k] !== 'string' || !section[k] || section[k] === v));
    if (!possible.length) continue;
    const [section] = possible;
    if (possible.length !== 1 || !fields.every(([k, v]) => section?.[k] === v) ||
        typeof section.text !== 'string' || !section.text.trim()) ambiguous = true;
    else turnRulings[key] = section.text;
  }
  return { turnRulings, ...(ambiguous ? { warning: '部分宿主裁定段的来源不明确，已跳过对应裁定。' } : {}) };
}

function historyFits({ history, input }, turn) {
  // Normal DTOs can include the just-staged user and empty assistant. They are
  // a cross-check, never a way to infer a turn number from the last floor.
  let end = history.length;
  const last = history[end - 1];
  if (last?.role === 'assistant' && last.text === '' && !last.greeting && validTurn(last.turn)) {
    if (last.turn !== turn) return false;
    end--;
    const user = history[end - 1];
    if (user?.turn === turn && user.role === 'user') {
      if (user.text !== input.raw && user.text !== input.text) return false;
      end--;
    }
  }
  for (let i = 0; i < end; i++) {
    const prior = history[i]?.turn;
    if (prior !== undefined && (!validTurn(prior) || prior >= turn)) return false;
  }
  return true;
}

// The public read has no signal argument. Reject promptly on cancellation even
// if the underlying read has not completed; a normal read failure only omits the extra.
async function readFrame(tavern, gameId, turn, signal) {
  signal?.throwIfAborted();
  let abort;
  try {
    if (typeof tavern.getRequestContext !== 'function') return undefined;
    const read = tavern.getRequestContext({ gameId, turn });
    if (!signal) return await read;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const frame = await Promise.race([read, stopped]);
    signal.throwIfAborted();
    return frame;
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
    return undefined;
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

export function createTurnRulings(tavern) {
  const recent = new Map();
  function remember(gameId, ticket) {
    recent.delete(gameId);
    recent.set(gameId, ticket);
    if (recent.size > 64) recent.delete(recent.keys().next().value);
  }
  tavern.turnSection?.({ name: 'turn-ruling-observer', text({ gameId, turn, input }) {
    // Observe only the callback's coordinates. Never request context, change
    // the native prompt, call either judge, or store the raw input / its rulings.
    if (typeof gameId === 'string' && gameId) {
      const prior = recent.get(gameId);
      remember(gameId, validTurn(turn) && typeof input === 'string'
        ? { gameId, turn, rawDigest: rawDigest(input), previous: prior?.claimed === false ? prior.turn : undefined, claimed: false }
        : null);
    }
    return '';
  } });
  // These are vetoes only; a previous ticket is never used to *choose* a frame.
  const forget = ({ gameId }) => remember(gameId, null);
  tavern.onGameRemoved?.(forget);
  tavern.onTimelineChanged?.(forget);
  // Without the live half (reload/eviction), the same native turn and input
  // could now belong to another branch. A persistent config alone isn't proof.
  function stillCurrent(binding) {
    const ticket = recent.get(binding.gameId);
    return ticket?.id === binding.id && ticket.turn === binding.turn && ticket.rawDigest === binding.rawDigest;
  }
  return {
    take(gameId) {
      const ticket = recent.get(gameId);
      if (!ticket || ticket.claimed) return undefined;
      ticket.claimed = true; // single-use, including failed/disabled prepare
      return ticket;
    },
    async bind(ticket, settings, reason, signal) {
      if (!ticket || reason !== 'normal' || !sources.some(s => settings[s.setting] === true)) return undefined;
      const { gameId, turn, previous } = ticket;
      if (previous !== undefined) {
        // Other generators also run turnSection but never consume our ticket.
        // Only accept a later observation if its predecessor actually landed.
        if (previous >= turn) return undefined;
        const prior = await readFrame(tavern, gameId, previous, signal);
        if (prior?.turn !== previous || (prior.gameId !== undefined && prior.gameId !== gameId)) return undefined;
      }
      // Normal turnSection precedes prepare; the host hasn't saved this frame
      // yet. Never promote an older unconsumed observation with a readable frame.
      if (await readFrame(tavern, gameId, turn, signal) !== null || recent.get(gameId) !== ticket) return undefined;
      ticket.id = randomUUID();
      return { gameId, turn, rawDigest: ticket.rawDigest, id: ticket.id };
    },
    async collect(materials, { settings, turnRulingBinding: binding }, signal) {
      const enabled = sources.filter(s => settings[s.setting] === true);
      if (!enabled.length) return {};
      // Public schema v1 omits target/branch/frame IDs. operationId is opaque:
      // timeline-generated on normal, a new UUID unrelated to the original frame
      // on replacement/retry. getTurnState is a story floor, not that native turn.
      if (materials.reason !== 'normal') return { warning: '宿主未提供可核验的重试或重生成目标帧，已跳过动态裁定。' };
      if (!binding || !binding.id || binding.gameId !== materials.gameId || !validTurn(binding.turn) ||
          !stillCurrent(binding) || binding.rawDigest !== rawDigest(materials.input.raw) || !historyFits(materials, binding.turn)) return unverified;
      const frame = await readFrame(tavern, materials.gameId, binding.turn, signal);
      if (!stillCurrent(binding) || frame?.turn !== binding.turn || (frame.gameId !== undefined && frame.gameId !== materials.gameId) ||
          frame.input !== (materials.input.text || materials.input.raw) || !Array.isArray(frame.sections)) return unverified;
      return selectSections(frame, enabled);
    },
  };
}
