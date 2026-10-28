import { describe, expect, it } from 'vitest';
import {
  defaultPreferences,
  isIsoCurrencyCode,
} from '../../src/shared/domain/preferences';
import {
  INVITATION_LINK_PREFIX,
  isUuid,
  parseInvitationInput,
  validateCreateAccountRequest,
  validateCommitCsvImportRequest,
  validateBudgetName,
  validateCreateBudgetRequest,
  validateCreateInvitationRequest,
  validateEmailAddress,
  validatePreferencesRequest,
  validateReadLocalStatementRequest,
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

  it('validates create account requests', () => {
    expect(
      validateCreateAccountRequest({
        budget_id: UUID,
        label: ' Main account ',
        currency: 'CHF',
        account_type: 'CHECKING',
      }),
    ).toEqual({
      budget_id: UUID,
      label: 'Main account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });

    expect(
      validateCreateAccountRequest({
        budget_id: UUID,
        label: 'Savings',
        currency: 'PLN',
        account_type: 'SAVINGS',
        owner_membership_id: UUID,
        institution_name: 'Bank AG',
        account_id: UUID,
      }),
    ).toEqual({
      budget_id: UUID,
      label: 'Savings',
      currency: 'PLN',
      account_type: 'SAVINGS',
      owner_membership_id: UUID,
      institution_name: 'Bank AG',
      account_id: UUID,
    });
    expect(
      validateCreateAccountRequest({
        budget_id: UUID,
        label: '',
        currency: 'CHF',
        account_type: 'CHECKING',
      }),
    ).toBeNull();
    expect(
      validateCreateAccountRequest({
        budget_id: UUID,
        label: 'Main',
        currency: 'chf',
        account_type: 'CHECKING',
      }),
    ).toBeNull();
    expect(
      validateCreateAccountRequest({
        budget_id: UUID,
        label: 'Main',
        currency: 'CHF',
        account_type: 'CARD',
      }),
    ).toBeNull();
  });

  it('validates CSV import decisions and canonical transaction fields', () => {
    const request = {
      budget_id: UUID,
      account_id: UUID,
      file_sha256: 'a'.repeat(64),
      parser_id: 'history-v1',
      parser_version: '1.0.0',
      rows: [
        {
          row_number: 2,
          decision: 'include',
          operation_date: '2026-03-01',
          description: ' Synthetic purchase ',
          amount: '12.3400',
          currency: 'CHF',
          transaction_type: 'EXPENSE',
          fee: '0.3000',
          balance: '987.6600',
          balance_currency: 'CHF',
        },
        { row_number: 3, decision: 'exclude' },
      ],
    };
    expect(validateCommitCsvImportRequest(request)).toEqual({
      ...request,
      rows: [
        {
          ...request.rows[0],
          description: 'Synthetic purchase',
        },
        request.rows[1],
      ],
    });
    expect(
      validateCommitCsvImportRequest({
        ...request,
        rows: [{ ...request.rows[0], decision: 'pending' }],
      }),
    ).toBeNull();
    expect(
      validateCommitCsvImportRequest({
        ...request,
        rows: [{ ...request.rows[0], operation_date: '2026-02-30' }],
      }),
    ).toBeNull();
    expect(
      validateCommitCsvImportRequest({
        ...request,
        rows: [{ ...request.rows[0], amount: '12,34' }],
      }),
    ).toBeNull();
    expect(
      validateCommitCsvImportRequest({
        ...request,
        rows: [
          {
            ...request.rows[0],
            balance_currency: undefined,
          },
        ],
      }),
    ).toBeNull();
  });

  it('validates local statement read requests', () => {
    expect(
      validateReadLocalStatementRequest({
        filePath: 'C:\\temp\\statement.csv',
      }),
    ).toMatchObject({
      filePath: 'C:\\temp\\statement.csv',
    });
    expect(
      validateReadLocalStatementRequest({
        filePath: ' C:\\temp\\statement.pdf ',
        maxBytes: 4096,
      }),
    ).toEqual({
      filePath: 'C:\\temp\\statement.pdf',
      maxBytes: 4096,
    });
    expect(validateReadLocalStatementRequest({ filePath: '' })).toBeNull();
    expect(
      validateReadLocalStatementRequest({
        filePath: 'C:\\temp\\statement.csv',
        maxBytes: 100,
      }),
    ).toBeNull();
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
