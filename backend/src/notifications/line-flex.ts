import type { TicketRecord } from '../tickets/types.js';
import { detectSafetyHazard } from '../triage/safety.js';
import type { LineMessage } from './line-messenger.js';
import { formatBangkok } from './work-order-email.js';

/**
 * LINE Flex Messages for the reporter (SCFRMS-45): the receipt, the
 * assignment notice, the work-started notice, the completion notice with a
 * Re-open button and the merge notice (SCFRMS-44). The builders are pure
 * functions; the caller passes the building security number and the LIFF app
 * URL.
 *
 * Rules from the Security, Roles & SLA requirements:
 *  - SLA-02: the receipt shows building security's number and the Thai
 *    emergency numbers, because this app is not an emergency channel.
 *  - SR-32: resident-written text is untrusted, so it is cut to a short length
 *    and stripped of control characters before it goes into a message.
 *  - RR-04: a reporter sees the team name only, never staff names or notes.
 *  - The completion notice shows the proof-of-repair photo when the caller
 *    passes a signed image URL. That URL expires sooner than the message
 *    stays in the chat, so the "View details" button opens the LIFF app, which
 *    asks the API for a fresh short-lived photo link.
 */

export const EMERGENCY_NUMBERS = {
  police: '191',
  fire: '199',
  medical: '1669',
} as const;

export interface FlexOptions {
  /** Building security phone number; the call button is left out when unset or invalid. */
  securityPhone?: string;
  /** Base URL of the LIFF app (https://liff.line.me/<liffId>); buttons are left out when unset. */
  liffUrl?: string;
  /** Signed https URL of the proof-of-repair photo; the completion notice shows no image when unset. */
  proofPhotoUrl?: string;
}

const TEAM_LABELS: Record<string, string> = {
  ELECTRICAL: 'Electrical',
  PLUMBING: 'Plumbing',
  HVAC: 'Air conditioning (HVAC)',
  CLEANING_SANITATION: 'Cleaning and sanitation',
  BUILDING_EQUIPMENT: 'Building equipment',
};

const COLORS = {
  text: '#1F2937',
  muted: '#6B7280',
  accent: '#0F766E',
  danger: '#B91C1C',
};

const MAX_LOCATION_LENGTH = 80;
const MAX_ALT_TEXT_LENGTH = 400;

type FlexComponent = Record<string, unknown>;

/** Resident text made safe for a message: no control characters, one line, cut to `max`. */
export function cleanText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const oneLine = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const squeezed = oneLine.replace(/\s{2,}/g, ' ');
  return squeezed.length > max ? `${squeezed.slice(0, max - 1)}…` : squeezed;
}

/** The number as a tel: link target, or null if it does not look like a phone number. */
function telTarget(phone: string | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!/^\+?[0-9][0-9 ()-]{3,19}$/.test(trimmed)) return null;
  return `tel:${trimmed.replace(/[ ()-]/g, '')}`;
}

/** An https LIFF URL for a ticket page, or null when no valid base URL is configured. */
function ticketUrl(
  liffUrl: string | undefined,
  ticketId: string,
  suffix = '',
): string | null {
  if (!liffUrl || !liffUrl.startsWith('https://')) return null;
  return `${liffUrl.replace(/\/+$/, '')}/tickets/${encodeURIComponent(ticketId)}${suffix}`;
}

function text(
  value: string,
  extra: Record<string, unknown> = {},
): FlexComponent {
  return {
    type: 'text',
    text: value,
    wrap: true,
    size: 'sm',
    color: COLORS.text,
    ...extra,
  };
}

function row(label: string, value: string): FlexComponent {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      text(label, { color: COLORS.muted, flex: 2, size: 'xs' }),
      text(value, { flex: 5 }),
    ],
  };
}

function button(
  label: string,
  uri: string,
  style: 'primary' | 'secondary' = 'secondary',
): FlexComponent {
  return {
    type: 'button',
    style,
    height: 'sm',
    action: { type: 'uri', label, uri },
  };
}

function bubble(
  altText: string,
  title: string,
  body: FlexComponent[],
  footer: FlexComponent[],
  titleColor: string = COLORS.accent,
  heroImageUrl: string | null = null,
): LineMessage {
  const contents: Record<string, unknown> = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        text(title, { weight: 'bold', size: 'lg', color: titleColor }),
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: body },
  };
  if (heroImageUrl) {
    contents.hero = {
      type: 'image',
      url: heroImageUrl,
      size: 'full',
      aspectRatio: '4:3',
      aspectMode: 'cover',
    };
  }
  if (footer.length > 0) {
    contents.footer = {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: footer,
    };
  }
  return {
    type: 'flex',
    altText: altText.slice(0, MAX_ALT_TEXT_LENGTH),
    contents,
  };
}

function teamLabel(teamId: string | undefined): string {
  return (teamId && TEAM_LABELS[teamId]) || 'maintenance';
}

/** The "not an emergency channel" block, with building security's number when known. */
function emergencyBlock(options: FlexOptions): FlexComponent[] {
  const security = options.securityPhone?.trim();
  const lines = [
    'This chat is not an emergency channel.',
    `In an emergency call police ${EMERGENCY_NUMBERS.police}, fire ${EMERGENCY_NUMBERS.fire} or ambulance ${EMERGENCY_NUMBERS.medical}.`,
  ];
  if (security && telTarget(security)) {
    lines.push(`Building security: ${security}`);
  }
  return [
    { type: 'separator', margin: 'md' },
    ...lines.map((line) => text(line, { size: 'xs', color: COLORS.muted })),
  ];
}

function callButton(options: FlexOptions): FlexComponent[] {
  const tel = telTarget(options.securityPhone);
  return tel ? [button('Call building security', tel)] : [];
}

/** Receipt sent when the report is saved (status RECEIVED). */
export function buildReceiptMessage(
  ticket: TicketRecord,
  options: FlexOptions = {},
): LineMessage {
  const hazard = detectSafetyHazard(ticket.description) !== null;
  const body: FlexComponent[] = [];
  if (hazard) {
    body.push(
      text(
        'This may be an emergency. Please call building security or the emergency services now.',
        { weight: 'bold', color: COLORS.danger },
      ),
    );
  }
  body.push(
    text('We have received your report.'),
    row('Ticket', ticket.id),
    row('Location', cleanText(ticket.location, MAX_LOCATION_LENGTH)),
    row('Received', `${formatBangkok(ticket.createdAt)} (Bangkok time)`),
    ...emergencyBlock(options),
  );

  const footer: FlexComponent[] = [...callButton(options)];
  const details = ticketUrl(options.liffUrl, ticket.id);
  if (details) footer.push(button('View report', details));

  return bubble(
    `Report received: ${ticket.id}`,
    hazard ? 'Report received: possible emergency' : 'Report received',
    body,
    footer,
    hazard ? COLORS.danger : COLORS.accent,
  );
}

/** Sent when triage has assigned the report to a team. */
export function buildAssignedMessage(
  ticket: TicketRecord,
  options: FlexOptions = {},
): LineMessage {
  const label = teamLabel(ticket.teamId);
  const footer: FlexComponent[] = [];
  const details = ticketUrl(options.liffUrl, ticket.id);
  if (details) footer.push(button('View report', details));

  return bubble(
    `Your report ${ticket.id} was assigned to the ${label} team`,
    'Report assigned',
    [
      text(`Your report was assigned to the ${label} team.`),
      row('Ticket', ticket.id),
      row('Location', cleanText(ticket.location, MAX_LOCATION_LENGTH)),
    ],
    footer,
  );
}

/** Sent when a technician starts the work (IN_PROGRESS). */
export function buildStartedMessage(
  ticket: TicketRecord,
  options: FlexOptions = {},
): LineMessage {
  const label = teamLabel(ticket.teamId);
  const footer: FlexComponent[] = [];
  const details = ticketUrl(options.liffUrl, ticket.id);
  if (details) footer.push(button('View report', details));

  return bubble(
    `Work started on your report ${ticket.id}`,
    'Work started',
    [
      text(`The ${label} team has started work on your report.`),
      row('Ticket', ticket.id),
      row('Location', cleanText(ticket.location, MAX_LOCATION_LENGTH)),
    ],
    footer,
  );
}

/**
 * Sent when the reporter reopens a finished repair (REOPENED): the team has it
 * again, so the repair is checked a second time.
 */
export function buildReopenedMessage(
  ticket: TicketRecord,
  options: FlexOptions = {},
): LineMessage {
  const label = teamLabel(ticket.teamId);
  const footer: FlexComponent[] = [];
  const details = ticketUrl(options.liffUrl, ticket.id);
  if (details) footer.push(button('View report', details));

  return bubble(
    `Your report ${ticket.id} was reopened`,
    'Report reopened',
    [
      text(
        `Your report was reopened and sent back to the ${label} team to check the repair again.`,
      ),
      row('Ticket', ticket.id),
      row('Location', cleanText(ticket.location, MAX_LOCATION_LENGTH)),
    ],
    footer,
  );
}

/**
 * Sent to the reporters of a ticket that a technician merged into another
 * report of the same problem (RR-02). `ticket` is the merged ticket; the link
 * opens the ticket it was merged into, which its reporters are linked to.
 */
export function buildMergedMessage(
  ticket: TicketRecord,
  options: FlexOptions = {},
): LineMessage | null {
  const into = ticket.mergedIntoTicketId;
  if (!into) return null;

  const footer: FlexComponent[] = [];
  const details = ticketUrl(options.liffUrl, into);
  if (details) footer.push(button('View report', details));

  return bubble(
    `Your report ${ticket.id} was merged into ${into}`,
    'Report merged',
    [
      text(
        'A technician found that another report describes the same problem and merged yours into it. You will get updates on that report.',
      ),
      row('Your ticket', ticket.id),
      row('Now tracked as', into),
      row('Location', cleanText(ticket.location, MAX_LOCATION_LENGTH)),
    ],
    footer,
  );
}

/** A signed https URL that fits LINE's 2000 character limit, or null. */
function imageUrl(url: string | undefined): string | null {
  if (!url || !url.startsWith('https://') || url.length > 2000) return null;
  return url;
}

/**
 * Sent when the repair is finished (DONE): shows the proof photo when a signed
 * URL is given, and offers View details and Re-open.
 */
export function buildCompletedMessage(
  ticket: TicketRecord,
  options: FlexOptions = {},
): LineMessage {
  const footer: FlexComponent[] = [];
  const details = ticketUrl(options.liffUrl, ticket.id);
  const reopen = ticketUrl(options.liffUrl, ticket.id, '/reopen');
  if (details)
    footer.push(button('View details and photo', details, 'primary'));
  if (reopen) footer.push(button('Re-open', reopen));

  return bubble(
    `Repair completed for your report ${ticket.id}`,
    'Repair completed',
    [
      text('The repair for your report is finished.'),
      row('Ticket', ticket.id),
      row('Location', cleanText(ticket.location, MAX_LOCATION_LENGTH)),
      text(
        'If the problem is still there, you can re-open the report within 7 days.',
        { size: 'xs', color: COLORS.muted },
      ),
    ],
    footer,
    COLORS.accent,
    imageUrl(options.proofPhotoUrl),
  );
}
