import { describe, expect, it } from 'vitest';

/**
 * Smoke test of the deployed callable wiring on the Auth, Firestore and
 * Functions emulators: ID-token authentication, payload mapping and error
 * codes. Business rules are covered in tests/integration.
 */
const PROJECT = 'demo-income-tracker';
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'}`;
const FUNCTIONS = `http://${process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001'}`;
const REGION = 'us-central1';

interface CallResult {
  status: number;
  result?: unknown;
  error?: { status: string; message: string; details?: { code?: string } };
}

async function signUp(
  email: string,
): Promise<{ idToken: string; uid: string }> {
  const response = await fetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'test-password-123',
        displayName: email.split('@')[0],
        returnSecureToken: true,
      }),
    },
  );
  const body = (await response.json()) as { idToken: string; localId: string };
  return { idToken: body.idToken, uid: body.localId };
}

async function call(
  name: string,
  idToken: string | null,
  data: unknown = {},
): Promise<CallResult> {
  const response = await fetch(`${FUNCTIONS}/${PROJECT}/${REGION}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify({ data }),
  });
  const body = (await response.json()) as Omit<CallResult, 'status'>;
  return { status: response.status, ...body };
}

describe('callable functions on the emulators (I-FR-01, I-FR-02, I-FR-04)', () => {
  const suffix = Date.now();

  it('authenticates with the ID token and serves the budget lifecycle', async () => {
    const alice = await signUp(`alice-${suffix}@example.test`);
    const bob = await signUp(`bob-${suffix}@example.test`);

    const prefs = await call('ensureUserProfile', alice.idToken);
    expect(prefs.result).toMatchObject({
      user_id: alice.uid,
      primary_currency: 'CHF',
      secondary_currencies: ['PLN', 'EUR'],
    });

    const created = await call('createBudget', alice.idToken, { name: 'Home' });
    const budget = created.result as { budget_id: string };
    expect(budget.budget_id).toMatch(/^[0-9a-f-]{36}$/);

    const account = await call('createAccount', alice.idToken, {
      budget_id: budget.budget_id,
      label: 'Main account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });
    const accountId = (account.result as { account_id: string }).account_id;
    expect(accountId).toMatch(/^[0-9a-f-]{36}$/);

    const imported = await call('commitCsvImport', alice.idToken, {
      budget_id: budget.budget_id,
      account_id: accountId,
      file_sha256: 'a'.repeat(64),
      parser_id: 'history-v1',
      parser_version: '1.0.0',
      rows: [
        {
          row_number: 2,
          decision: 'include',
          operation_date: '2026-03-01',
          description: 'Synthetic callable import',
          amount: '1.25',
          currency: 'CHF',
          transaction_type: 'EXPENSE',
          bank_transaction_id: 'synthetic-bank-row',
        },
      ],
    });
    expect(imported.result).toMatchObject({
      imported_row_count: 1,
      already_imported: false,
    });

    const category = await call('saveCategory', alice.idToken, {
      budget_id: budget.budget_id,
      name: 'Synthetic callable category',
      kind: 'EXPENSE',
      sort_order: 0,
    });
    const categoryId = (category.result as { category_id: string }).category_id;
    const rule = await call('saveCategorizationRule', alice.idToken, {
      budget_id: budget.budget_id,
      category_id: categoryId,
      match_field: 'DESCRIPTION',
      operator: 'CONTAINS',
      match_value: 'callable manual',
      priority: 1,
    });
    expect(rule.result).toMatchObject({ rule_id: expect.any(String) });

    const manual = await call('saveTransaction', alice.idToken, {
      budget_id: budget.budget_id,
      account_id: accountId,
      operation_date: '2026-03-02',
      description: 'Synthetic callable manual transaction',
      amount: '2.5000',
      currency: 'CHF',
      type: 'EXPENSE',
      note: 'Synthetic note',
      tags: ['synthetic'],
    });
    expect(manual.result).toMatchObject({
      transaction_id: expect.any(String),
    });

    const invitation = await call('createInvitation', alice.idToken, {
      budget_id: budget.budget_id,
    });
    const { token } = invitation.result as { token: string };

    const joined = await call('acceptInvitation', bob.idToken, { token });
    expect(joined.result).toMatchObject({ budget_id: budget.budget_id });

    const reused = await call('acceptInvitation', bob.idToken, { token });
    expect(reused.error?.status).toBe('FAILED_PRECONDITION');
    expect(reused.error?.details?.code).toBe('INVITATION_NOT_PENDING');

    const left = await call('leaveBudget', bob.idToken, {
      budget_id: budget.budget_id,
    });
    expect(left.result).toEqual({
      budget_deleted: false,
      cleanup_pending: false,
    });
  });

  it('rejects unauthenticated and malformed calls with typed errors', async () => {
    const anonymous = await call('createBudget', null, { name: 'Home' });
    expect(anonymous.error?.status).toBe('UNAUTHENTICATED');

    const user = await signUp(`carol-${suffix}@example.test`);
    const invalid = await call('createBudget', user.idToken, { name: '   ' });
    expect(invalid.error?.status).toBe('INVALID_ARGUMENT');
    expect(invalid.error?.details?.code).toBe('INVALID_ARGUMENT');
  });

  it('deletes the login identity together with the profile', async () => {
    const user = await signUp(`dave-${suffix}@example.test`);
    await call('ensureUserProfile', user.idToken);
    await call('createBudget', user.idToken, { name: 'Solo' });

    const deleted = await call('deleteMyProfile', user.idToken);
    expect(deleted.result).toMatchObject({ cleanup_pending_budget_ids: [] });

    const lookup = await fetch(
      `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `dave-${suffix}@example.test`,
          password: 'test-password-123',
          returnSecureToken: true,
        }),
      },
    );
    expect(lookup.status).toBe(400);
  });
});
