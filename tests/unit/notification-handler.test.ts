import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import type { TicketRecord } from '../../backend/src/tickets/types';

vi.mock('../../backend/src/shared/ticket-repository', () => ({
  getTicket: vi.fn(),
}));
vi.mock('../../backend/src/notifications/notification-log', () => ({
  hasSent: vi.fn(),
  markSent: vi.fn(),
}));
vi.mock('../../backend/src/notifications/work-order-email', () => ({
  sendWorkOrderEmail: vi.fn(),
}));
vi.mock('../../backend/src/notifications/line-notification', () => ({
  lineReporterChannel: {
    name: 'LINE_REPORTER',
    kinds: ['CREATED', 'TRIAGED', 'MERGED', 'REOPENED'],
    recipients: vi.fn(),
    send: vi.fn(),
  },
}));

vi.mock('../../backend/src/notifications/sla-breach-notification', () => ({
  emailSupervisorsChannel: {
    name: 'EMAIL_SUPERVISORS',
    kinds: ['SLA_BREACHED', 'SLA_RESPONSE_BREACHED', 'SLA_TRIAGE_DELAYED'],
    recipients: vi.fn(),
    send: vi.fn(),
  },
}));
vi.mock('../../backend/src/notifications/sla-warning-notification', () => ({
  emailTeamWarningChannel: {
    name: 'EMAIL_TEAM_WARNING',
    kinds: ['SLA_WARNING'],
    recipients: vi.fn(),
    send: vi.fn(),
  },
}));

import {
  CHANNELS,
  handler,
  selectChannels,
} from '../../backend/src/notifications/notification-handler';
import { getTicket } from '../../backend/src/shared/ticket-repository';
import {
  hasSent,
  markSent,
} from '../../backend/src/notifications/notification-log';
import { sendWorkOrderEmail } from '../../backend/src/notifications/work-order-email';
import { lineReporterChannel } from '../../backend/src/notifications/line-notification';

import { emailSupervisorsChannel } from '../../backend/src/notifications/sla-breach-notification';

import { emailTeamWarningChannel } from '../../backend/src/notifications/sla-warning-notification';

const warningRecipients = vi.mocked(emailTeamWarningChannel.recipients);
const warningSend = vi.mocked(emailTeamWarningChannel.send);
const supervisorRecipients = vi.mocked(emailSupervisorsChannel.recipients);
const supervisorSend = vi.mocked(emailSupervisorsChannel.send);
const lineRecipients = vi.mocked(lineReporterChannel.recipients);
const lineSend = vi.mocked(lineReporterChannel.send);

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_1',
    location: 'Lobby',
    description: 'Water is leaking.',
    status: 'ASSIGNED',
    repairCycle: 1,
    photos: [],
    version: 2,
    reporterLineUserId: 'Uaaa',
    category: 'PLUMBING',
    priority: 'CRITICAL',
    teamId: 'PLUMBING',
    deadlineAt: '2026-10-29T07:00:00.000Z',
    createdAt: '2026-10-29T03:00:00.000Z',
    updatedAt: '2026-10-29T03:01:00.000Z',
    ...overrides,
  };
}

function record(
  kind: string,
  sequence: string,
  eventName: 'INSERT' | 'MODIFY' = 'INSERT',
  eventId = `tkt_1_${kind.toLowerCase()}`,
): DynamoDBRecord {
  return {
    eventName,
    dynamodb: {
      SequenceNumber: sequence,
      NewImage: {
        ticketId: { S: 'tkt_1' },
        id: { S: eventId },
        kind: { S: kind },
      },
    },
  };
}

function eventOf(...records: DynamoDBRecord[]): DynamoDBStreamEvent {
  return { Records: records };
}

const triaged = (sequence = '1') => record('TRIAGED', sequence);
const created = (sequence = '1') => record('CREATED', sequence);

describe('notification stream handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(hasSent).mockResolvedValue(false);
    vi.mocked(markSent).mockResolvedValue(undefined);
    vi.mocked(getTicket).mockResolvedValue(ticket());
    vi.mocked(sendWorkOrderEmail).mockResolvedValue('SENT');
    lineRecipients.mockResolvedValue(['Uaaa', 'Ubbb']);
    lineSend.mockResolvedValue(true);
  });

  it('emails the team and messages every reporter when a ticket is triaged', async () => {
    const result = await handler(eventOf(triaged()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sendWorkOrderEmail).toHaveBeenCalledWith(ticket());
    expect(lineSend).toHaveBeenCalledTimes(2);
    expect(lineSend).toHaveBeenCalledWith(ticket(), 'Uaaa', {
      ticketId: 'tkt_1',
      eventId: 'tkt_1_triaged',
      kind: 'TRIAGED',
    });
    expect(lineSend).toHaveBeenCalledWith(
      ticket(),
      'Ubbb',
      expect.objectContaining({ kind: 'TRIAGED' }),
    );
    expect(
      vi.mocked(markSent).mock.calls.map((call) => call.slice(0, 3)),
    ).toEqual([
      ['tkt_1', 'tkt_1_triaged', 'EMAIL_TEAM:PLUMBING'],
      ['tkt_1', 'tkt_1_triaged', 'LINE_REPORTER:Uaaa'],
      ['tkt_1', 'tkt_1_triaged', 'LINE_REPORTER:Ubbb'],
    ]);
    expect(markSent).toHaveBeenCalledWith(
      'tkt_1',
      'tkt_1_triaged',
      'EMAIL_TEAM:PLUMBING',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it('alerts every supervisor, and nobody else, when an SLA breach is recorded', async () => {
    supervisorRecipients.mockResolvedValue(['a@example.com', 'b@example.com']);
    supervisorSend.mockResolvedValue(true);

    const result = await handler(eventOf(record('SLA_BREACHED', '1')));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(supervisorSend).toHaveBeenCalledTimes(2);
    expect(supervisorSend).toHaveBeenCalledWith(ticket(), 'a@example.com', {
      ticketId: 'tkt_1',
      eventId: 'tkt_1_sla_breached',
      kind: 'SLA_BREACHED',
    });
    expect(
      vi.mocked(markSent).mock.calls.map((call) => call.slice(0, 3)),
    ).toEqual([
      ['tkt_1', 'tkt_1_sla_breached', 'EMAIL_SUPERVISORS:a@example.com'],
      ['tkt_1', 'tkt_1_sla_breached', 'EMAIL_SUPERVISORS:b@example.com'],
    ]);
    // The reporters and the team are not told that the team is late.
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).not.toHaveBeenCalled();
  });

  it('alerts the supervisors, and no one else, when a ticket misses its response target', async () => {
    supervisorRecipients.mockResolvedValue(['a@example.com']);
    supervisorSend.mockResolvedValue(true);

    await handler(eventOf(record('SLA_RESPONSE_BREACHED', '1')));

    expect(supervisorSend).toHaveBeenCalledWith(ticket(), 'a@example.com', {
      ticketId: 'tkt_1',
      eventId: 'tkt_1_sla_response_breached',
      kind: 'SLA_RESPONSE_BREACHED',
    });
    expect(warningSend).not.toHaveBeenCalled();
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).not.toHaveBeenCalled();
  });

  it('alerts the supervisors, and no one else, when a ticket waits too long for triage', async () => {
    supervisorRecipients.mockResolvedValue(['a@example.com']);
    supervisorSend.mockResolvedValue(true);

    await handler(eventOf(record('SLA_TRIAGE_DELAYED', '1')));

    expect(supervisorSend).toHaveBeenCalledWith(ticket(), 'a@example.com', {
      ticketId: 'tkt_1',
      eventId: 'tkt_1_sla_triage_delayed',
      kind: 'SLA_TRIAGE_DELAYED',
    });
    expect(warningSend).not.toHaveBeenCalled();
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).not.toHaveBeenCalled();
  });

  it('warns the team, and no one else, when a ticket has used 75% of its time', async () => {
    warningRecipients.mockResolvedValue(['PLUMBING']);
    warningSend.mockResolvedValue(true);

    await handler(eventOf(record('SLA_WARNING', '1')));

    expect(warningSend).toHaveBeenCalledWith(ticket(), 'PLUMBING', {
      ticketId: 'tkt_1',
      eventId: 'tkt_1_sla_warning',
      kind: 'SLA_WARNING',
    });
    expect(vi.mocked(markSent).mock.calls.map((c) => c.slice(0, 3))).toEqual([
      ['tkt_1', 'tkt_1_sla_warning', 'EMAIL_TEAM_WARNING:PLUMBING'],
    ]);
    expect(supervisorSend).not.toHaveBeenCalled();
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).not.toHaveBeenCalled();
  });

  it('does not mark a warning as sent when the team has no address', async () => {
    warningRecipients.mockResolvedValue(['PLUMBING']);
    warningSend.mockResolvedValue(false);
    await handler(eventOf(record('SLA_WARNING', '1')));
    expect(markSent).not.toHaveBeenCalled();
  });

  it('does not alert a supervisor again on a retry, and does not alert for other events', async () => {
    supervisorRecipients.mockResolvedValue(['a@example.com', 'b@example.com']);
    supervisorSend.mockResolvedValue(true);
    vi.mocked(hasSent).mockImplementation(
      async (_t, _e, key) => key === 'EMAIL_SUPERVISORS:a@example.com',
    );

    await handler(eventOf(record('SLA_BREACHED', '1')));
    expect(supervisorSend).toHaveBeenCalledTimes(1);
    expect(supervisorSend).toHaveBeenCalledWith(
      ticket(),
      'b@example.com',
      expect.anything(),
    );

    supervisorSend.mockClear();
    await handler(eventOf(triaged(), created('2')));
    expect(supervisorSend).not.toHaveBeenCalled();
  });

  it('sends only the LINE receipt when a ticket is created', async () => {
    await handler(eventOf(created()));

    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).toHaveBeenCalledTimes(2);
    expect(lineSend).toHaveBeenCalledWith(
      ticket(),
      'Uaaa',
      expect.objectContaining({
        kind: 'CREATED',
        eventId: 'tkt_1_created',
      }),
    );
  });

  it('sends only the LINE merge notice when a ticket is merged into another', async () => {
    await handler(eventOf(record('MERGED', '1')));

    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).toHaveBeenCalledTimes(2);
    expect(lineSend).toHaveBeenCalledWith(
      ticket(),
      'Uaaa',
      expect.objectContaining({ kind: 'MERGED', eventId: 'tkt_1_merged' }),
    );
  });

  it('sends only the LINE reopened notice, and no work order email, when a ticket is reopened', async () => {
    const result = await handler(eventOf(record('REOPENED', '1')));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).toHaveBeenCalledTimes(2);
    expect(lineSend).toHaveBeenCalledWith(
      ticket(),
      'Uaaa',
      expect.objectContaining({
        kind: 'REOPENED',
        eventId: 'tkt_1_reopened',
      }),
    );
  });

  it('sends nothing for the event written on the ticket that took the merge', async () => {
    await handler(eventOf(record('DUPLICATES_MERGED', '1')));

    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).not.toHaveBeenCalled();
  });

  it.each([
    ['an event kind no channel handles', record('PRIORITY_CHANGED', '1')],
    ['a MODIFY of an event', record('TRIAGED', '1', 'MODIFY')],
    ['a record without an image', { eventName: 'INSERT' } as DynamoDBRecord],
    [
      'an event without a kind',
      {
        eventName: 'INSERT',
        dynamodb: {
          NewImage: { ticketId: { S: 'tkt_1' }, id: { S: 'tkt_1_triaged' } },
        },
      } as DynamoDBRecord,
    ],
  ])('ignores %s', async (_label, rec) => {
    const result = await handler(eventOf(rec));
    expect(result).toEqual({ batchItemFailures: [] });
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).not.toHaveBeenCalled();
    expect(getTicket).not.toHaveBeenCalled();
  });

  it('skips a recipient that already got the message and still messages the rest', async () => {
    vi.mocked(hasSent).mockImplementation(
      async (_ticketId, _eventId, key) =>
        key === 'EMAIL_TEAM:PLUMBING' || key === 'LINE_REPORTER:Uaaa',
    );

    await handler(eventOf(triaged()));

    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).toHaveBeenCalledTimes(1);
    expect(lineSend).toHaveBeenCalledWith(
      ticket(),
      'Ubbb',
      expect.objectContaining({ kind: 'TRIAGED' }),
    );
    expect(markSent).toHaveBeenCalledTimes(1);
  });

  it('sends nothing again for an event that was fully handled', async () => {
    vi.mocked(hasSent).mockResolvedValue(true);

    await handler(eventOf(triaged()));

    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });

  it('does not record a message that was not actually sent', async () => {
    vi.mocked(sendWorkOrderEmail).mockResolvedValue('NO_RECIPIENT');
    lineSend.mockResolvedValue(false);

    const result = await handler(eventOf(triaged()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(markSent).not.toHaveBeenCalled();
  });

  it('logs and moves on when the ticket no longer exists', async () => {
    vi.mocked(getTicket).mockResolvedValue(null);

    const result = await handler(eventOf(triaged()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sendWorkOrderEmail).not.toHaveBeenCalled();
    expect(lineSend).not.toHaveBeenCalled();
  });

  it('handles every event in a batch', async () => {
    await handler(
      eventOf(
        created('1'),
        triaged('2'),
        record('TRIAGED', '3', 'INSERT', 'e3'),
      ),
    );
    // created: 2 LINE; triaged: 1 email + 2 LINE; third event: same keys but another event id
    expect(lineSend).toHaveBeenCalledTimes(6);
    expect(sendWorkOrderEmail).toHaveBeenCalledTimes(2);
  });

  it('keeps the messages already sent when a later recipient fails, and retries from that record', async () => {
    lineSend.mockImplementation(async (_ticket, recipient) => {
      if (recipient === 'Ubbb') throw new Error('LINE is down');
      return true;
    });

    const result = await handler(
      eventOf(triaged('10'), record('TRIAGED', '11', 'INSERT', 'e2')),
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '10' }] });
    const recorded = vi.mocked(markSent).mock.calls.map((call) => call[2]);
    expect(recorded).toEqual(['EMAIL_TEAM:PLUMBING', 'LINE_REPORTER:Uaaa']);
    // the second event is left for the retry
    expect(getTicket).toHaveBeenCalledOnce();
  });

  it('reports a temporary email failure so Lambda retries from there, after messaging the reporters', async () => {
    vi.mocked(sendWorkOrderEmail).mockRejectedValue(new Error('throttled'));

    const result = await handler(
      eventOf(triaged('10'), record('TRIAGED', '11', 'INSERT', 'e2')),
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '10' }] });
    expect(sendWorkOrderEmail).toHaveBeenCalledOnce();
    // the LINE messages of the same event still went out and were recorded
    expect(vi.mocked(markSent).mock.calls.map((call) => call[2])).toEqual([
      'LINE_REPORTER:Uaaa',
      'LINE_REPORTER:Ubbb',
    ]);
    // the second event is left for the retry
    expect(getTicket).toHaveBeenCalledOnce();
  });

  it('retries when recording a send fails, rather than losing the record', async () => {
    vi.mocked(markSent).mockRejectedValue(new Error('dynamo down'));

    const result = await handler(eventOf(triaged('7')));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '7' }] });
  });

  it('rethrows a temporary failure when the record has no sequence number', async () => {
    vi.mocked(sendWorkOrderEmail).mockRejectedValue(new Error('throttled'));
    const rec = triaged();
    delete rec.dynamodb?.SequenceNumber;

    await expect(handler(eventOf(rec))).rejects.toThrow('throttled');
  });

  it('never writes a recipient LINE user id to the logs (SR-35)', async () => {
    lineSend.mockRejectedValueOnce(new Error('LINE is down'));

    await handler(eventOf(triaged('5')));
    await handler(eventOf(created('6')));

    const logged = JSON.stringify([
      ...vi.mocked(console.info).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]);
    expect(logged).not.toContain('Uaaa');
    expect(logged).not.toContain('Ubbb');
    expect(logged).toContain('LINE_REPORTER');
  });
});

describe('independent channels', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(hasSent).mockResolvedValue(false);
    vi.mocked(markSent).mockResolvedValue(undefined);
    vi.mocked(getTicket).mockResolvedValue(ticket());
    vi.mocked(sendWorkOrderEmail).mockResolvedValue('SENT');
    lineRecipients.mockResolvedValue(['Uaaa', 'Ubbb']);
    lineSend.mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllEnvs());

  describe('NOTIFICATION_CHANNELS', () => {
    it('runs every channel when it is unset or empty', () => {
      expect(selectChannels(undefined)).toEqual(CHANNELS);
      expect(selectChannels('')).toEqual(CHANNELS);
      expect(selectChannels(' , ')).toEqual(CHANNELS);
    });

    it('runs only the channels it names, ignoring spaces and empty entries', () => {
      expect(selectChannels('LINE_REPORTER').map((c) => c.name)).toEqual([
        'LINE_REPORTER',
      ]);
      expect(selectChannels(' EMAIL_TEAM , ').map((c) => c.name)).toEqual([
        'EMAIL_TEAM',
      ]);
      expect(
        selectChannels('LINE_REPORTER,EMAIL_TEAM').map((c) => c.name),
      ).toEqual(['EMAIL_TEAM', 'LINE_REPORTER']);
    });

    it('rejects a name that matches no channel, and says which', () => {
      expect(() => selectChannels('LINE_REPORTER,SMS')).toThrow(
        /unknown channel: SMS\. Known channels: EMAIL_TEAM, LINE_REPORTER, EMAIL_SUPERVISORS, EMAIL_TEAM_WARNING\./,
      );
      // case matters: a channel name is part of the notification log keys
      expect(() => selectChannels('line_reporter')).toThrow('unknown channel');
    });

    it('lets a LINE-only deployment message the reporters without touching SES', async () => {
      vi.stubEnv('NOTIFICATION_CHANNELS', 'LINE_REPORTER');
      // SES is not set up: if it were called, the record would fail
      vi.mocked(sendWorkOrderEmail).mockRejectedValue(
        new Error('SES_SENDER_EMAIL environment variable is not set.'),
      );

      const result = await handler(eventOf(triaged('3')));

      expect(result).toEqual({ batchItemFailures: [] });
      expect(sendWorkOrderEmail).not.toHaveBeenCalled();
      expect(lineSend).toHaveBeenCalledTimes(2);
      expect(vi.mocked(markSent).mock.calls.map((call) => call[2])).toEqual([
        'LINE_REPORTER:Uaaa',
        'LINE_REPORTER:Ubbb',
      ]);
    });

    it('lets an email-only deployment skip LINE', async () => {
      vi.stubEnv('NOTIFICATION_CHANNELS', 'EMAIL_TEAM');
      await handler(eventOf(triaged('3')));
      expect(sendWorkOrderEmail).toHaveBeenCalledOnce();
      expect(lineSend).not.toHaveBeenCalled();
      expect(lineRecipients).not.toHaveBeenCalled();
    });

    it('still sends no LINE message for an event kind the LINE channel ignores', async () => {
      vi.stubEnv('NOTIFICATION_CHANNELS', 'LINE_REPORTER');
      await handler(eventOf(record('PRIORITY_CHANGED', '1')));
      expect(getTicket).not.toHaveBeenCalled();
      expect(lineSend).not.toHaveBeenCalled();
    });

    it('reports a misspelt setting as a failed record and sends nothing', async () => {
      vi.stubEnv('NOTIFICATION_CHANNELS', 'LINE');

      const result = await handler(eventOf(triaged('4')));

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '4' }] });
      expect(lineSend).not.toHaveBeenCalled();
      expect(sendWorkOrderEmail).not.toHaveBeenCalled();
      // an Error does not show in JSON, so read the message of the logged error
      const messages = vi
        .mocked(console.error)
        .mock.calls.flat()
        .map((arg) => (arg as { err?: Error })?.err?.message ?? '')
        .join(' ');
      expect(messages).toContain('NOTIFICATION_CHANNELS');
    });
  });

  describe('a failure in one place', () => {
    it('does not hold back the LINE messages when the email fails, and the retry sends only the email', async () => {
      vi.mocked(sendWorkOrderEmail).mockRejectedValue(new Error('SES is down'));

      const first = await handler(eventOf(triaged('10')));

      expect(first).toEqual({ batchItemFailures: [{ itemIdentifier: '10' }] });
      expect(lineSend).toHaveBeenCalledTimes(2);
      const recorded = vi.mocked(markSent).mock.calls.map((call) => call[2]);
      expect(recorded).toEqual(['LINE_REPORTER:Uaaa', 'LINE_REPORTER:Ubbb']);

      // the retry: LINE was recorded, the email now works
      vi.mocked(hasSent).mockImplementation(async (_t, _e, key) =>
        recorded.includes(key),
      );
      vi.mocked(sendWorkOrderEmail).mockResolvedValue('SENT');
      lineSend.mockClear();

      const retry = await handler(eventOf(triaged('10')));

      expect(retry).toEqual({ batchItemFailures: [] });
      expect(lineSend).not.toHaveBeenCalled();
      expect(vi.mocked(markSent).mock.calls.at(-1)?.[2]).toBe(
        'EMAIL_TEAM:PLUMBING',
      );
    });

    it('does not hold back the email when LINE fails', async () => {
      lineSend.mockRejectedValue(new Error('LINE is down'));

      const result = await handler(eventOf(triaged('10')));

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '10' }] });
      expect(vi.mocked(markSent).mock.calls.map((call) => call[2])).toEqual([
        'EMAIL_TEAM:PLUMBING',
      ]);
    });

    it('does not hold back the other reporters when one fails', async () => {
      lineSend.mockImplementation(async (_ticket, recipient) => {
        if (recipient === 'Uaaa') throw new Error('LINE is down');
        return true;
      });

      const result = await handler(eventOf(created('9')));

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '9' }] });
      expect(lineSend).toHaveBeenCalledTimes(2);
      expect(vi.mocked(markSent).mock.calls.map((call) => call[2])).toEqual([
        'LINE_REPORTER:Ubbb',
      ]);
    });

    it('does not hold back the email when the reporters cannot be listed', async () => {
      lineRecipients.mockRejectedValue(new Error('dynamo down'));

      const result = await handler(eventOf(triaged('8')));

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '8' }] });
      expect(sendWorkOrderEmail).toHaveBeenCalledOnce();
      expect(vi.mocked(markSent).mock.calls.map((call) => call[2])).toEqual([
        'EMAIL_TEAM:PLUMBING',
      ]);
    });

    it('reports the first failure when several things fail, so the log shows a cause', async () => {
      vi.mocked(sendWorkOrderEmail).mockRejectedValue(new Error('SES is down'));
      lineSend.mockRejectedValue(new Error('LINE is down'));
      const rec = triaged();
      delete rec.dynamodb?.SequenceNumber;

      await expect(handler(eventOf(rec))).rejects.toThrow('SES is down');
      // every place was still tried
      expect(lineSend).toHaveBeenCalledTimes(2);
    });

    it('logs each failure with the channel and no LINE user id (SR-35)', async () => {
      vi.mocked(sendWorkOrderEmail).mockRejectedValue(new Error('SES is down'));
      lineSend.mockRejectedValue(new Error('LINE is down'));

      await handler(eventOf(triaged('10')));

      const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
      expect(logged).toContain('EMAIL_TEAM');
      expect(logged).toContain('LINE_REPORTER');
      expect(logged).not.toContain('Uaaa');
      expect(logged).not.toContain('Ubbb');
    });
  });
});
