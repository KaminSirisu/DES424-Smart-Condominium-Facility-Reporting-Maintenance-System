import { describe, expect, it } from 'vitest';
import type { LineMessage } from '../../backend/src/notifications/line-messenger';
import type { TicketRecord } from '../../backend/src/tickets/types';
import {
  EMERGENCY_NUMBERS,
  buildAssignedMessage,
  buildCompletedMessage,
  buildMergedMessage,
  buildReopenedMessage,
  buildReceiptMessage,
  buildStartedMessage,
  cleanText,
} from '../../backend/src/notifications/line-flex';

const LIFF = 'https://liff.line.me/1234567890-AbCdEfGh';

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'tkt_0123456789abcdef0123456789',
    location: 'Beside the lobby elevator',
    description: 'Water is leaking from the ceiling.',
    status: 'RECEIVED',
    repairCycle: 1,
    photos: [],
    version: 1,
    reporterLineUserId: 'Uabc123',
    teamId: 'PLUMBING',
    createdAt: '2026-10-29T03:00:00.000Z',
    updatedAt: '2026-10-29T03:00:00.000Z',
    ...overrides,
  };
}

/** Every text value in a message, to search what a reader would see. */
function allText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allText);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const own = typeof record.text === 'string' ? [record.text] : [];
    return [...own, ...Object.values(record).flatMap(allText)];
  }
  return [];
}

function actions(message: LineMessage): {
  label: string;
  uri: string;
}[] {
  const found: { label: string; uri: string }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (record.type === 'uri') {
      found.push({
        label: String(record.label),
        uri: String(record.uri),
      });
    }
    Object.values(record).forEach(walk);
  };
  walk(message.contents);
  return found;
}

const builders = [
  ['receipt', buildReceiptMessage],
  ['assigned', buildAssignedMessage],
  ['started', buildStartedMessage],
  ['completed', buildCompletedMessage],
] as const;

describe.each(builders)('%s message', (_name, build) => {
  it('is a Flex bubble with alt text within LINE limits', () => {
    const message = build(ticket(), {
      securityPhone: '02-123-4567',
      liffUrl: LIFF,
    });
    expect(message.type).toBe('flex');
    expect(typeof message.altText).toBe('string');
    expect((message.altText as string).length).toBeLessThanOrEqual(400);
    expect((message.contents as { type: string }).type).toBe('bubble');
    expect(JSON.stringify(message).length).toBeLessThan(30_000);
  });

  it('shows the ticket id and location', () => {
    const texts = allText(build(ticket()));
    expect(texts).toContain('tkt_0123456789abcdef0123456789');
    expect(texts).toContain('Beside the lobby elevator');
  });

  it('never contains the reporter LINE user id or the description', () => {
    const json = JSON.stringify(
      build(ticket({ description: 'Secret description text' }), {
        liffUrl: LIFF,
      }),
    );
    expect(json).not.toContain('Uabc123');
    expect(json).not.toContain('Secret description text');
  });

  it('cleans a hostile location', () => {
    const texts = allText(
      build(ticket({ location: `Lobby\r\n\u0000${'x'.repeat(500)}` })),
    );
    const location = texts.find((t) => t.startsWith('Lobby')) ?? '';
    expect(location).not.toContain('\n');
    expect(location).not.toContain('\r');
    expect(location).not.toContain('\u0000');
    expect(location.length).toBeLessThanOrEqual(80);
  });

  it('leaves out buttons when no LIFF URL is set, or it is not https', () => {
    for (const liffUrl of [undefined, '', 'http://liff.line.me/x']) {
      const uris = actions(build(ticket(), { liffUrl })).map((a) => a.uri);
      expect(uris.filter((u) => u.includes('/tickets/'))).toEqual([]);
    }
  });
});

describe('receipt', () => {
  it('always shows the emergency numbers and says this is not an emergency channel', () => {
    const texts = allText(buildReceiptMessage(ticket())).join(' ');
    expect(texts).toContain('not an emergency channel');
    for (const number of Object.values(EMERGENCY_NUMBERS)) {
      expect(texts).toContain(number);
    }
    expect(Object.values(EMERGENCY_NUMBERS)).toEqual(['191', '199', '1669']);
  });

  it('shows building security and a call button when the number is set', () => {
    const message = buildReceiptMessage(ticket(), {
      securityPhone: '02-123-4567',
    });
    expect(allText(message).join(' ')).toContain(
      'Building security: 02-123-4567',
    );
    expect(actions(message)).toContainEqual({
      label: 'Call building security',
      uri: 'tel:021234567',
    });
  });

  it.each([undefined, '', 'call me', '12', '02-123-4567; rm -rf /'])(
    'leaves out building security for %j',
    (securityPhone) => {
      const message = buildReceiptMessage(ticket(), { securityPhone });
      expect(allText(message).join(' ')).not.toContain('Building security');
      expect(actions(message).some((a) => a.uri.startsWith('tel:'))).toBe(
        false,
      );
    },
  );

  it('adds an emergency banner when the description reports a safety hazard', () => {
    const hazard = buildReceiptMessage(
      ticket({ description: 'I can smell gas in the corridor.' }),
    );
    expect(allText(hazard).join(' ')).toContain('This may be an emergency');
    expect(allText(hazard)).toContain('Report received: possible emergency');

    const ordinary = buildReceiptMessage(ticket());
    expect(allText(ordinary).join(' ')).not.toContain('may be an emergency');
    expect(allText(ordinary)).toContain('Report received');
  });

  it('shows the received time in Bangkok time', () => {
    expect(allText(buildReceiptMessage(ticket())).join(' ')).toContain(
      '2026-10-29 10:00 (Bangkok time)',
    );
  });

  it('links to the report in the LIFF app', () => {
    expect(
      actions(buildReceiptMessage(ticket(), { liffUrl: `${LIFF}/` })),
    ).toContainEqual({
      label: 'View report',
      uri: `${LIFF}/tickets/tkt_0123456789abcdef0123456789`,
    });
  });
});

describe('assigned message', () => {
  it('names the team with a readable label and no staff details', () => {
    const texts = allText(
      buildAssignedMessage(ticket({ teamId: 'HVAC' })),
    ).join(' ');
    expect(texts).toContain('Air conditioning (HVAC) team');
    expect(texts).not.toMatch(/staff|technician/i);
  });

  it('falls back to a generic label for an unknown team', () => {
    expect(
      allText(buildAssignedMessage(ticket({ teamId: 'ROOFING' }))).join(' '),
    ).toContain('maintenance team');
  });
});

describe('started message', () => {
  it('says the team has started work', () => {
    expect(allText(buildStartedMessage(ticket())).join(' ')).toContain(
      'Plumbing team has started work',
    );
  });
});

describe('completed message', () => {
  it('offers View details and Re-open as LIFF links', () => {
    const id = 'tkt_0123456789abcdef0123456789';
    expect(actions(buildCompletedMessage(ticket(), { liffUrl: LIFF }))).toEqual(
      [
        { label: 'View details and photo', uri: `${LIFF}/tickets/${id}` },
        { label: 'Re-open', uri: `${LIFF}/tickets/${id}/reopen` },
      ],
    );
  });

  it('shows the proof-of-repair photo when a signed https URL is given', () => {
    const photo = 'https://bucket.s3.amazonaws.com/proof?X-Amz-Signature=abc';
    const message = buildCompletedMessage(ticket(), {
      liffUrl: LIFF,
      proofPhotoUrl: photo,
    });
    expect((message.contents as { hero?: unknown }).hero).toEqual({
      type: 'image',
      url: photo,
      size: 'full',
      aspectRatio: '4:3',
      aspectMode: 'cover',
    });
  });

  it.each([
    ['not given', undefined],
    ['empty', ''],
    ['not https', 'http://bucket.example.com/proof.jpg'],
    ['too long for LINE', `https://bucket.example.com/${'a'.repeat(2000)}`],
  ])('shows no image when the photo URL is %s', (_label, proofPhotoUrl) => {
    const message = buildCompletedMessage(ticket(), {
      liffUrl: LIFF,
      proofPhotoUrl,
    });
    expect(message.contents).not.toHaveProperty('hero');
  });

  it('never exposes the private S3 key of a stored photo', () => {
    const message = buildCompletedMessage(
      ticket({
        photos: [
          {
            id: 'upl_1',
            purpose: 'REPAIR_PROOF',
            addedAt: '2026-10-29T08:00:00.000Z',
            s3ObjectKey: 'uploads/REPAIR_PROOF/Ustaff/upl_1',
          },
        ],
      }),
      { liffUrl: LIFF },
    );
    expect(JSON.stringify(message)).not.toContain('uploads/');
  });

  it('mentions the 7 day re-open window', () => {
    expect(allText(buildCompletedMessage(ticket())).join(' ')).toContain(
      'within 7 days',
    );
  });

  it('url-encodes the ticket id in links', () => {
    const uris = actions(
      buildCompletedMessage(ticket({ id: 'tkt a/b' }), { liffUrl: LIFF }),
    ).map((a) => a.uri);
    expect(uris[0]).toBe(`${LIFF}/tickets/tkt%20a%2Fb`);
  });
});

describe('buildReopenedMessage', () => {
  const reopened = () => ticket({ status: 'ASSIGNED', repairCycle: 2 });

  it('tells the reporter the repair will be checked again', () => {
    const message = buildReopenedMessage(reopened(), { liffUrl: LIFF });

    expect(message.altText).toBe(`Your report ${reopened().id} was reopened`);
    const text = allText(message).join(' ');
    expect(text).toContain('reopened');
    expect(text).toContain(reopened().id);
    expect(text).toContain('Beside the lobby elevator');
  });

  it('opens the report, and does not offer to re-open it again', () => {
    const json = JSON.stringify(
      buildReopenedMessage(reopened(), { liffUrl: LIFF }),
    );

    expect(json).toContain(`${LIFF}/tickets/${reopened().id}`);
    expect(json).not.toContain('/reopen');
    expect(json).not.toContain('Re-open');
  });

  it('leaves the button out without a LIFF url', () => {
    expect(JSON.stringify(buildReopenedMessage(reopened()))).not.toContain(
      '"uri"',
    );
  });
});

describe('buildMergedMessage', () => {
  const merged = () =>
    ticket({
      id: 'tkt_dup1',
      status: 'MERGED',
      mergedIntoTicketId: 'tkt_main',
    });

  it('tells the reporter which ticket the report was merged into', () => {
    const message = buildMergedMessage(merged(), { liffUrl: LIFF });

    expect(message?.altText).toBe(
      'Your report tkt_dup1 was merged into tkt_main',
    );
    const text = allText(message).join(' ');
    expect(text).toContain('tkt_dup1');
    expect(text).toContain('tkt_main');
    expect(text).toContain('Beside the lobby elevator');
  });

  it('opens the ticket it was merged into', () => {
    const json = JSON.stringify(
      buildMergedMessage(merged(), { liffUrl: LIFF }),
    );

    expect(json).toContain(`${LIFF}/tickets/tkt_main`);
    expect(json).not.toContain(`${LIFF}/tickets/tkt_dup1`);
  });

  it('leaves the button out without a LIFF url', () => {
    expect(JSON.stringify(buildMergedMessage(merged()))).not.toContain('"uri"');
  });

  it('sends nothing for a ticket that was not merged', () => {
    expect(buildMergedMessage(ticket())).toBeNull();
  });

  it('shows no staff names or internal ids (RR-04)', () => {
    const text = JSON.stringify(
      buildMergedMessage({ ...merged(), reporterLineUserId: 'Usecret' }),
    );
    expect(text).not.toContain('Usecret');
  });
});

describe('cleanText', () => {
  it('flattens whitespace and control characters', () => {
    expect(cleanText('  a\n\n b\t\tc  ', 50)).toBe('a b c');
  });

  it('cuts long text with an ellipsis', () => {
    const cut = cleanText('x'.repeat(100), 10);
    expect(cut).toHaveLength(10);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('keeps non-Latin text and emoji intact', () => {
    // Thai "elevator broken" and a construction sign, written as escapes
    const text =
      '\u0e25\u0e34\u0e1f\u0e15\u0e4c\u0e0a\u0e33\u0e23\u0e38\u0e14 \u{1f6a7}';
    expect(cleanText(text, 50)).toBe(text);
  });
});
