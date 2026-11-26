// Claude field condense must pass the observer output cap into
// optimizeObservationFields, the same 7th argument the HTTP providers pass.
// Without it the prompt asks for a character budget the cap cannot carry.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ClaudeProvider } from '../../src/services/worker/ClaudeProvider.js';
import { observationFieldMaxChars, resolveObserverMaxOutputTokens } from '../../src/services/worker/context-window.js';
import { fieldCompressionBudget } from '../../src/services/worker/field-optimizer.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

type QueuedMessage = Record<string, unknown>;

function makeSession(): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'condense-session',
    memorySessionId: 'mem-session-1',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'read the files',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
  } as ActiveSession;
}

function sessionManagerHolding(events: QueuedMessage[]): SessionManager {
  const queue = events.map((event, i) => ({ ...event, _persistentId: i + 1, _originalTimestamp: 1_000 + i }));
  return {
    getMessageIterator: async function* () {
      while (queue.length > 0) yield queue.shift();
    },
    claimNextObservation: mock(() => null),
    getClaimedMessages: mock(() => []),
    confirmClaimedMessages: mock(() => Promise.resolve(0)),
    resetProcessingToPending: mock(() => Promise.resolve(0)),
    clearPendingForSession: mock(() => Promise.resolve(0)),
  } as unknown as SessionManager;
}

describe('Claude condense passes the observer output cap', () => {
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let settings = SettingsDefaultsManager.getAllDefaults();
  const answeringPacer = { mark: () => 0, waitForAnswer: async () => 'answered' };

  beforeEach(() => {
    settings = SettingsDefaultsManager.getAllDefaults();
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => settings);
    const realMode = ModeManager.getInstance().loadMode('code');
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => realMode,
      loadMode: () => {},
    } as unknown as ModeManager));
  });

  afterEach(() => {
    modeManagerSpy.mockRestore();
    mock.restore();
  });

  it.each(['4096', '1024'])('asks the compressor for the budget of CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS=%s', async (cap) => {
    settings = { ...settings, CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS: cap };
    const fieldMax = observationFieldMaxChars(undefined);
    const oversized = 'x'.repeat(fieldMax + 100);
    const asked: number[] = [];
    const dbManager = {
      getSessionStore: () => ({
        ensureMemorySessionIdRegistered: mock(() => {}),
        updateMemorySessionId: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'mem-session-1' })),
      }),
      getSessionById: mock(() => ({ memory_session_id: 'mem-session-1' })),
    } as unknown as DatabaseManager;
    const provider = new ClaudeProvider(dbManager, sessionManagerHolding([{
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file_path: 'src/small.ts' },
      tool_response: oversized,
      prompt_number: 1,
    }])) as any;

    const generator = provider.createMessageGenerator(
      makeSession(),
      { lastCwd: undefined },
      { current: null },
      undefined,
      async (_text: string, budget: number) => {
        asked.push(budget);
        return { text: 'condensed', truncated: false };
      },
      answeringPacer,
    );
    for await (const _message of generator) { /* drain */ }

    const tokens = resolveObserverMaxOutputTokens();
    expect(tokens).toBe(Number(cap));
    expect(asked).toEqual([fieldCompressionBudget(fieldMax, tokens)]);
    expect(asked[0]).toBeLessThan(fieldCompressionBudget(fieldMax));
  });
});
