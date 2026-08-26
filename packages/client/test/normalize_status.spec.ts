import { describe, expect, it } from 'vitest';
import { normalizeStatus } from '../src/transports/normalize_status.js';

describe('normalizeStatus', () => {
  it('maps known raw statuses', () => {
    expect(normalizeStatus('connected')).toBe('connected');
    expect(normalizeStatus('disconnected')).toBe('disconnected');
  });

  it('falls back for unknown/empty raw values', () => {
    expect(normalizeStatus('weird')).toBe('connecting');
    expect(normalizeStatus(undefined)).toBe('connecting');
    expect(normalizeStatus('synced', 'connected')).toBe('connected');
  });
});
