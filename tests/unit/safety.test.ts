import { describe, expect, it } from 'vitest';
import { detectSafetyHazard } from '../../backend/src/triage/safety.js';

describe('detectSafetyHazard', () => {
  it.each([
    ['There is a fire in the bin room', 'FIRE'],
    ['Something is on fire near the pool', 'FIRE'],
    ['FIRE!!! in the corridor', 'FIRE'],
    ['Thick smoke is coming from the vent', 'SMOKE'],
    ['I can smell burning in the lobby', 'SMOKE'],
    ['It smells of smoke on level 3', 'SMOKE'],
    ['I smell gas in the kitchen area', 'GAS'],
    ['Gas leak near the generator', 'GAS'],
    ['LPG smell near the kitchen', 'GAS'],
    ['The air conditioner smells of gas', 'GAS'],
    ['A child got an electric shock from the socket', 'ELECTRIC_SHOCK'],
    ['Risk of electrical shock at the pump room', 'ELECTRIC_SHOCK'],
    ['The cable is sparking', 'ELECTRIC_SHOCK'],
    ['Exposed wires hanging from the ceiling', 'ELECTRIC_SHOCK'],
    ['Someone is trapped in the lift', 'TRAPPED'],
    ['A man is stuck in the elevator', 'TRAPPED'],
    ['Child locked in the restroom', 'TRAPPED'],
  ])('flags "%s" as %s', (text, hazard) => {
    expect(detectSafetyHazard(text)).toBe(hazard);
  });

  it.each([
    ['Flooding next to the main electrical panel', 'FLOOD_NEAR_ELECTRICAL'],
    ['Water is leaking onto the power sockets', 'FLOOD_NEAR_ELECTRICAL'],
    [
      'The corridor is flooded and the switchboard is wet',
      'FLOOD_NEAR_ELECTRICAL',
    ],
    ['A leak above the power socket in unit 5', 'FLOOD_NEAR_ELECTRICAL'],
    ['The electric water heater is leaking', 'FLOOD_NEAR_ELECTRICAL'],
  ])('flags "%s" as %s', (text, hazard) => {
    expect(detectSafetyHazard(text)).toBe(hazard);
  });

  it('does not treat flooding alone as a safety hazard', () => {
    expect(
      detectSafetyHazard('The pool deck is flooded after rain'),
    ).toBeNull();
  });

  it('does not treat an electrical fault alone as a safety hazard', () => {
    expect(detectSafetyHazard('The corridor light is flickering')).toBeNull();
  });

  it.each([
    'The fire extinguisher is empty',
    'Fire exit sign is not lit',
    'The fire door does not close',
    'Water is dripping from the air conditioner',
    'The elevator button is broken',
    'Pool light is out',
    'The air conditioner needs a gas refill',
    'AC is not cold, please refill refrigerant gas',
    'Water is leaking from the ceiling panel',
    'The floodlight wiring is broken',
  ])('does not flag the routine report "%s"', (text) => {
    expect(detectSafetyHazard(text)).toBeNull();
  });

  it('still flags a real fire in a report that mentions fire equipment', () => {
    expect(detectSafetyHazard('The fire exit is on fire')).toBe('FIRE');
  });

  it('handles typographic apostrophes and upper case', () => {
    expect(detectSafetyHazard('SOMEONE’S TRAPPED IN THE LIFT')).toBe('TRAPPED');
  });

  it('returns null for an empty description', () => {
    expect(detectSafetyHazard('')).toBeNull();
  });
});
