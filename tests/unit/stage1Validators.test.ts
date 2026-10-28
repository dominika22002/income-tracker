import { describe, expect, it } from 'vitest';
import {
  defaultPreferences,
  isIsoCurrencyCode,
} from '../../src/shared/domain/preferences';
import {
  INVITATION_LINK_PREFIX,
  isUuid,
  parseInvitationInput,
  validateBudgetName,
  validateCreateBudgetRequest,
  validateCreateInvitationRequest,
  validateEmailAddress,
  validatePreferencesRequest,
} from '../../src/shared/validators';

const UUID = '3f2b8c1e-7a4d-4c55-9e0a-1b2c3d4e5f60';
const TOKEN = 'A'.repeat(43);

describe('stage 1 request validators (U-FR-02, U-FR-03)', () => {
  it('validates budget names', () => {
    expect(validateBudgetName('  Home  ')).toBe('Home');
    expect(validateBudgetName('')).toBeNull();
    expect(validateBudgetName('   ')).toBeNull();
    expect(validateBudgetName('x'.repeat(101))).toBeNull();
    expect(validateBudgetName(42)).toBeNull();
  });

  it('validates create budget requests', () => {
    expect(validateCreateBudgetRequest({ name: 'Home' })).toEqual({
      name: 'Home',
    });
    expect(
      validateCreateBudgetRequest({ name: 'Home', budget_id: UUID }),
    ).toEqual({ name: 'Home', budget_id: UUID });
    expect(
      validateCreateBudgetRequest({ name: 'Home', budget_id: 'nope' }),
    ).toBeNull();
    expect(validateCreateBudgetRequest(null)).toBeNull();
    expect(validateCreateBudgetRequest({ name: '' })).toBeNull();
  });

  it('validates identifiers and e-mails', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid('budget-a')).toBe(false);
    expect(validateEmailAddress('  Guest@Example.TEST ')).toBe(
      'guest@example.test',
    );
    expect(validateEmailAddress('not-an-email')).toBeNull();
    expect(validateEmailAddress('a@b')).toBeNull();
  });

  it('validates create invitation requests and normalizes e-mail', () => {
    expect(validateCreateInvitationRequest({ budget_id: UUID })).toEqual({
      budget_id: UUID,
    });
    expect(
      validateCreateInvitationRequest({
        budget_id: UUID,
        invitee_email: 'Guest@Example.test',
        invitation_id: UUID,
      }),
    ).toEqual({
      budget_id: UUID,
      invitee_email: 'guest@example.test',
      invitation_id: UUID,
    });
    expect(
      validateCreateInvitationRequest({ budget_id: UUID, invitee_email: 'x' }),
    ).toBeNull();
    expect(validateCreateInvitationRequest({ budget_id: 'x' })).toBeNull();
  });

  it('parses a token from a bare token or an invitation link', () => {
    expect(parseInvitationInput(TOKEN)).toBe(TOKEN);
    expect(parseInvitationInput(` ${INVITATION_LINK_PREFIX}${TOKEN} `)).toBe(
      TOKEN,
    );
    expect(parseInvitationInput('short')).toBeNull();
    expect(
      parseInvitationInput(`${INVITATION_LINK_PREFIX}bad token`),
    ).toBeNull();
    expect(parseInvitationInput(undefined)).toBeNull();
  });
});

describe('currency preferences (U-FR-21, U-FR-22)', () => {
  it('defaults to CHF with PLN and EUR as secondary currencies', () => {
    expect(defaultPreferences()).toEqual({
      primary_currency: 'CHF',
      secondary_currencies: ['PLN', 'EUR'],
    });
    expect(validatePreferencesRequest(defaultPreferences())).not.toBeNull();
  });

  it('returns a fresh copy of the defaults', () => {
    defaultPreferences().secondary_currencies.push('USD');
    expect(defaultPreferences().secondary_currencies).toEqual(['PLN', 'EUR']);
  });

  it('recognizes ISO 4217 codes only', () => {
    expect(isIsoCurrencyCode('USD')).toBe(true);
    expect(isIsoCurrencyCode('usd')).toBe(false);
    expect(isIsoCurrencyCode('ZZZ')).toBe(false);
    expect(isIsoCurrencyCode('US')).toBe(false);
  });

  it('accepts a custom primary currency and an empty secondary set', () => {
    expect(
      validatePreferencesRequest({
        primary_currency: 'USD',
        secondary_currencies: [],
      }),
    ).toEqual({ primary_currency: 'USD', secondary_currencies: [] });
  });

  it('rejects invalid, duplicate or conflicting currencies', () => {
    const invalid = [
      { primary_currency: 'XXX1', secondary_currencies: [] },
      { primary_currency: 'CHF', secondary_currencies: ['PLN', 'PLN'] },
      { primary_currency: 'CHF', secondary_currencies: ['CHF'] },
      { primary_currency: 'CHF', secondary_currencies: ['ZZZ'] },
      { primary_currency: 'CHF', secondary_currencies: 'PLN' },
      { primary_currency: 'CHF' },
      null,
    ];
    for (const input of invalid) {
      expect(validatePreferencesRequest(input)).toBeNull();
    }
  });
});
