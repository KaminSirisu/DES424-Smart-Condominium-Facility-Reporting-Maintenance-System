import { STATUS_LABEL } from './constants';
import { actorLabel, teamLabel } from './format';
import type { TicketEvent } from '../services/types';

/** Human-readable text for an audit event. Shared by the admin drawer and the staff UI. */
export function eventLabel(e: TicketEvent): string {
  switch (e.kind) {
    case 'CREATED':
      return 'Report received via LINE';
    case 'TRIAGED':
      return `${actorLabel(e)} triage${e.toTeamId ? `: ${teamLabel(e.toTeamId)}` : ''}${
        e.toPriority ? ` · ${e.toPriority}` : ''
      }`;
    case 'STATUS_CHANGED':
      return `Status: ${e.fromStatus ? STATUS_LABEL[e.fromStatus] : '?'} → ${
        e.toStatus ? STATUS_LABEL[e.toStatus] : '?'
      }`;
    case 'PRIORITY_CHANGED':
      return `Priority ${e.fromPriority} → ${e.toPriority}`;
    case 'PRIORITY_CONFIRMED':
      return `Priority ${e.toPriority} confirmed`;
    case 'REASSIGNED':
      return `Reassigned ${teamLabel(e.fromTeamId)} → ${teamLabel(e.toTeamId)}`;
    case 'DUPLICATES_MERGED':
      return 'Merged duplicate tickets';
    case 'MERGED':
      return 'Merged into another ticket';
    case 'REOPENED':
      return `Reopened by resident (cycle ${e.repairCycle})`;
    case 'SLA_WARNING':
      return 'SLA warning: 75% of time used';
    case 'SLA_RESPONSE_BREACHED':
      return 'Response target missed';
    case 'SLA_BREACHED':
      return 'SLA breached';
    case 'SLA_TRIAGE_DELAYED':
      return 'Triage delayed';
    default:
      return e.kind;
  }
}
