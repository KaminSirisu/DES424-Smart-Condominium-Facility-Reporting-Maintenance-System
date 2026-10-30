import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LinePushError,
  lineSender,
  retryKeyFor,
} from '../../backend/src/notifications/line-messenger';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const messages = [{ type: 'text', text: 'hello' }];

describe('retryKeyFor', () => {
  it('is a valid UUID', () => {
    expect(retryKeyFor('tkt_1_triaged', 'Uabc123')).toMatch(UUID);
  });

  it('is stable for the same event and user', () => {
    expect(retryKeyFor('tkt_1_triaged', 'Uabc123')).toBe(
      retryKeyFor('tkt_1_triaged', 'Uabc123'),
    );
  });

  it('differs per user and per event', () => {
    const base = retryKeyFor('tkt_1_triaged', 'Uabc123');
    expect(retryKeyFor('tkt_1_triaged', 'Udef456')).not.toBe(base);
    expect(retryKeyFor('tkt_1_created', 'Uabc123')).not.toBe(base);
  });
});

describe('LinePushError', () => {
  it.each([400, 404, 422])('treats %i as permanent', (status) => {
    expect(new LinePushError(status).permanent).toBe(true);
  });

  it.each([401, 403, 429, 500, 503])('treats %i as retryable', (status) => {
    expect(new LinePushError(status).permanent).toBe(false);
  });
});

describe('lineSender.push', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('LINE_CHANNEL_ACCESS_TOKEN', 'channel-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('posts the messages to the push endpoint with the retry key', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await lineSender.push('Uabc123', messages, 'retry-key-1');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.line.me/v2/bot/message/push');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer channel-token',
      'X-Line-Retry-Key': 'retry-key-1',
    });
    expect(JSON.parse(init.body)).toEqual({ to: 'Uabc123', messages });
  });

  it('treats 409 as success because LINE already accepted this retry key', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 });
    await expect(
      lineSender.push('Uabc123', messages, 'retry-key-1'),
    ).resolves.toBeUndefined();
  });

  it('throws LinePushError with the status for other failures', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    await expect(
      lineSender.push('Uabc123', messages, 'retry-key-1'),
    ).rejects.toMatchObject({ name: 'LinePushError', status: 429 });
  });

  it('does not put the token in the error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const err = await lineSender
      .push('Uabc123', messages, 'retry-key-1')
      .catch((e: Error) => e);
    expect((err as Error).message).not.toContain('channel-token');
  });

  it('fails clearly when the access token is not configured', async () => {
    vi.stubEnv('LINE_CHANNEL_ACCESS_TOKEN', '');
    await expect(
      lineSender.push('Uabc123', messages, 'retry-key-1'),
    ).rejects.toThrow(
      'LINE_CHANNEL_ACCESS_TOKEN environment variable is not set.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
