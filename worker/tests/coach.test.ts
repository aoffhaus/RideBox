import { describe, expect, it } from 'vitest';
import { buildUserMessage, validRequest } from '../coach';

describe('worker request handling', () => {
  it('validates the kind and shape', () => {
    expect(validRequest('plan', { kind: 'plan', context: {}, input: {} })).toBe(true);
    expect(validRequest('plan', { kind: 'today', context: {}, input: {} })).toBe(false);
    expect(validRequest('delete', { kind: 'delete', context: {}, input: {} })).toBe(false);
    expect(validRequest('today', null)).toBe(false);
  });
  it('puts the task, request and context in the prompt', () => {
    const m = buildUserMessage({ kind: 'today', context: { today: '2026-11-19' } as never, input: { minutes: 60, feel: 3 } });
    expect(m).toContain('Task: today');
    expect(m).toContain('"minutes":60');
    expect(m).toContain('"today":"2026-11-19"');
  });
});
