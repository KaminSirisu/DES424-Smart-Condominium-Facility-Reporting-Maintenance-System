/**
 * Safety override for AI triage (SLA-02).
 *
 * A report of fire, smoke, gas, electric shock risk, flooding near electrical
 * equipment, or a person trapped is CRITICAL whatever the impact and urgency
 * matrix says. This is decided here in code from the description, never by
 * the model, so a wrong or manipulated AI answer cannot lower it.
 *
 * Matching is deliberately broad: a false match only makes a ticket more
 * urgent than it needed to be, while a missed hazard delays an emergency.
 * Residents can also trigger it by typing a keyword; the per-user rate limit
 * on ticket creation is the guard against that.
 */

export const SAFETY_HAZARDS = [
  'FIRE',
  'SMOKE',
  'GAS',
  'ELECTRIC_SHOCK',
  'FLOOD_NEAR_ELECTRICAL',
  'TRAPPED',
] as const;
export type SafetyHazard = (typeof SAFETY_HAZARDS)[number];

interface Rule {
  hazard: SafetyHazard;
  pattern: RegExp;
  /** A reading of the text that cancels the match. */
  unless?: (text: string) => boolean;
}

// Air conditioner "gas" is refrigerant, which residents often ask to refill.
// Only a smell makes it a gas hazard.
const AIR_CON =
  /\bair[- ]?con\w*|\ba\/c\b|\brefrigerant\b|\bfreon\b|\bcompressor\b/;
const SMELL = /\bsmell\w*|\bodou?r\b|\bstink\w*|\bstench\b/;

const RULES: readonly Rule[] = [
  // "fire extinguisher", "fire exit" etc. name equipment, not an emergency.
  {
    hazard: 'FIRE',
    pattern: /\bfire\b(?!\s+(?:extinguisher|exit|door|hose|escape))/,
  },
  {
    hazard: 'SMOKE',
    pattern:
      /\bsmoke\b|\bsmell(?:s|ing)?\s+(?:of\s+)?(?:burn(?:ing|t)|smoke)\b/,
  },
  {
    hazard: 'GAS',
    pattern: /\bgas\b|\blpg\b/,
    unless: (text) => AIR_CON.test(text) && !SMELL.test(text),
  },
  {
    hazard: 'ELECTRIC_SHOCK',
    pattern:
      /\belectrocut\w*|\belectric(?:al)?\s+shock\w*|\bsparking\b|\bsparks\b|\bexposed\s+wir(?:e|es|ing)\b/,
  },
  {
    hazard: 'TRAPPED',
    pattern:
      /\btrapped\b|\bstuck\s+in\s+(?:the\s+)?(?:lift|elevator)\b|\blocked\s+in\b/,
  },
];

// Water near electrical equipment. "floodlight" and "ceiling panel" must not
// count, so flood is matched as a whole word and "panel" is not electrical.
const WATER = /\bflood(?:s|ed|ing|water)?\b|\bleak\w*/;
const ELECTRICAL =
  /\belectric\w*|\bsockets?\b|\boutlets?\b|\bwiring\b|\bwires?\b|\bpower\b|\bswitchboard\b|\bdistribution\s+board\b|\bbreaker\b|\bfuse\s+box\b|\btransformer\b/;

/** The first safety hazard the description reports, or null if none. */
export function detectSafetyHazard(description: string): SafetyHazard | null {
  const text = description.toLowerCase().replace(/[‘’]/g, "'");

  for (const { hazard, pattern, unless } of RULES) {
    if (pattern.test(text) && !unless?.(text)) return hazard;
  }
  if (WATER.test(text) && ELECTRICAL.test(text)) return 'FLOOD_NEAR_ELECTRICAL';
  return null;
}
