import React from 'react';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react';
import { type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { setLogLevel } from 'firebase/firestore';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { BudgetApp } from '../../src/renderer/src/features/budgets/BudgetApp';
import { clearFirestore, TestClock } from '../integration/helpers';
import {
  createRulesEnv,
  servicesFor,
  type FakeAuthGateway,
  type TestUser,
} from './harness';

const ALICE: TestUser = {
  uid: 'alice',
  email: 'alice@example.test',
  displayName: 'Alice',
};
const BOB: TestUser = {
  uid: 'bob',
  email: 'bob@example.test',
  displayName: 'Bob',
};
const CAROL: TestUser = {
  uid: 'carol',
  email: 'carol@example.test',
  displayName: 'Carol',
};

describe('budget access flows in the UI (E-FR-01…06, E-TR-14)', () => {
  let env: RulesTestEnvironment;
  const clock = new TestClock(new Date().toISOString());

  beforeAll(async () => {
    setLogLevel('silent');
    configure({ asyncUtilTimeout: 8000 });
    env = await createRulesEnv();
  });

  beforeEach(clearFirestore);
  afterEach(cleanup);
  afterAll(async () => {
    await env.cleanup();
  });

  /** One rendered app per user; each talks to the real services and rules. */
  function openApp(user: TestUser) {
    const { services, auth } = servicesFor(env, user, clock);
    const { container } = render(<BudgetApp services={services} />);
    return { ui: within(container), auth };
  }

  async function signIn(user: TestUser) {
    const app = openApp(user);
    fireEvent.click(
      await app.ui.findByRole('button', { name: 'Sign in with Google' }),
    );
    await app.ui.findByText(/Signed in as/);
    await app.ui.findByText(
      /not a member of any budget yet|\(ADMIN\)|\(MEMBER\)/,
    );
    return app;
  }

  type App = Awaited<ReturnType<typeof signIn>>;

  async function createBudget(app: App, name: string) {
    fireEvent.change(app.ui.getByLabelText(/Budget name/), {
      target: { value: name },
    });
    fireEvent.click(app.ui.getByRole('button', { name: 'Create budget' }));
    await app.ui.findByText(`Budget “${name}” created.`);
    await app.ui.findByText(`${name} (ADMIN)`);
  }

  async function openBudget(app: App, name: string) {
    fireEvent.click(
      await app.ui.findByRole('button', { name: `Open ${name}` }),
    );
    await app.ui.findByRole('heading', { name, level: 3 });
    await waitFor(() => {
      expect(app.ui.queryByText(/^Loading (members|invitations)…$/)).toBeNull();
    });
  }

  async function createLink(app: App): Promise<string> {
    fireEvent.click(
      app.ui.getByRole('button', { name: 'Create invitation link' }),
    );
    const link = await app.ui.findByTestId('invitation-link');
    return link.textContent ?? '';
  }

  function checkInvitation(app: App, link: string) {
    fireEvent.change(app.ui.getByLabelText(/Invitation link or token/), {
      target: { value: link },
    });
    fireEvent.click(app.ui.getByRole('button', { name: 'Check invitation' }));
  }

  it('signs in and out with the provider stand-in and rejects a failed sign-in (E-FR-01)', async () => {
    const { ui, auth } = openApp(ALICE);
    expect(await ui.findByText('Sign in to see your budgets.')).toBeTruthy();

    (auth as FakeAuthGateway).failNextSignIn = new Error('Login was cancelled');
    fireEvent.click(ui.getByRole('button', { name: 'Sign in with Google' }));
    expect((await ui.findByRole('alert')).textContent).toContain(
      'Login was cancelled',
    );
    expect(ui.queryByText(/Signed in as/)).toBeNull();

    fireEvent.click(ui.getByRole('button', { name: 'Sign in with Google' }));
    await ui.findByText(/Signed in as/);
    expect(ui.getByText('Alice')).toBeTruthy();
    expect(await ui.findByLabelText(/Primary currency/)).toHaveProperty(
      'value',
      'CHF',
    );
    expect(ui.getByLabelText(/Secondary currencies/)).toHaveProperty(
      'value',
      'PLN, EUR',
    );

    fireEvent.click(ui.getByRole('button', { name: 'Sign out' }));
    expect(await ui.findByText('Sign in to see your budgets.')).toBeTruthy();
  });

  it('creates a budget and lists it for the creator only (E-FR-02, E-FR-05)', async () => {
    const alice = await signIn(ALICE);
    const carol = await signIn(CAROL);
    await createBudget(alice, 'Home');

    expect(alice.ui.getByRole('list', { name: 'My budgets' })).toBeTruthy();
    await new Promise((done) => setTimeout(done, 300));
    expect(carol.ui.queryByText(/Home/)).toBeNull();
    expect(carol.ui.getByText(/not a member of any budget yet/)).toBeTruthy();
  });

  it('shows validation errors instead of success for invalid input', async () => {
    const alice = await signIn(ALICE);
    fireEvent.click(alice.ui.getByRole('button', { name: 'Create budget' }));
    expect((await alice.ui.findByRole('alert')).textContent).toContain(
      'not valid',
    );
    expect(alice.ui.queryByRole('status')).toBeNull();
  });

  it('invites, accepts, then removes a member who loses access at once (E-FR-03, E-FR-04, E-FR-06)', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    await createBudget(alice, 'Home');
    await openBudget(alice, 'Home');
    const link = await createLink(alice);
    expect(link).toMatch(
      /^income-tracker:\/\/invite\?token=[A-Za-z0-9_-]{43}$/,
    );

    checkInvitation(bob, link);
    await bob.ui.findByText('Invitation to join “Home”.');
    fireEvent.click(bob.ui.getByRole('button', { name: 'Accept invitation' }));
    await bob.ui.findByText('You joined “Home”.');
    await bob.ui.findByText('Home (MEMBER)');

    const members = await alice.ui.findByRole('list', { name: 'Members' });
    await within(members).findByText('Bob (MEMBER)');
    await waitFor(() =>
      expect(
        alice.ui.getByRole('list', { name: 'Invitations' }).textContent,
      ).toContain('ACCEPTED'),
    );

    // The link cannot be used again, not even by another user.
    const carol = await signIn(CAROL);
    checkInvitation(carol, link);
    await carol.ui.findByText(/can no longer be used \(accepted\)/);
    expect(
      carol.ui.queryByRole('button', { name: 'Accept invitation' }),
    ).toBeNull();

    // Only the admin sees removal controls.
    await openBudget(bob, 'Home');
    expect(bob.ui.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(
      bob.ui.queryByRole('button', { name: 'Create invitation link' }),
    ).toBeNull();

    fireEvent.click(
      await alice.ui.findByRole('button', { name: 'Remove Bob' }),
    );
    await alice.ui.findByText('Bob was removed.');
    await waitFor(() =>
      expect(bob.ui.queryByText(/Home \(MEMBER\)/)).toBeNull(),
    );
    expect(
      await bob.ui.findByText(/not a member of any budget yet/),
    ).toBeTruthy();
  });

  it('lets an invited person decline, and a declined link stays dead (E-FR-04)', async () => {
    const alice = await signIn(ALICE);
    const carol = await signIn(CAROL);
    await createBudget(alice, 'Home');
    await openBudget(alice, 'Home');
    const link = await createLink(alice);

    checkInvitation(carol, link);
    await carol.ui.findByText('Invitation to join “Home”.');
    fireEvent.click(
      carol.ui.getByRole('button', { name: 'Decline invitation' }),
    );
    await carol.ui.findByText('Invitation declined.');
    expect(carol.ui.getByText(/not a member of any budget yet/)).toBeTruthy();

    checkInvitation(carol, link);
    await carol.ui.findByText(/can no longer be used \(declined\)/);
    await waitFor(() =>
      expect(
        alice.ui.getByRole('list', { name: 'Invitations' }).textContent,
      ).toContain('DECLINED'),
    );
  });

  it('lets the admin cancel a link before it is used (E-FR-04)', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    await createBudget(alice, 'Home');
    await openBudget(alice, 'Home');
    const link = await createLink(alice);

    fireEvent.click(
      await alice.ui.findByRole('button', { name: 'Cancel invitation' }),
    );
    await alice.ui.findByText('Invitation cancelled.');

    checkInvitation(bob, link);
    await bob.ui.findByText(/can no longer be used \(cancelled\)/);
  });

  it('lets a member leave and hands the admin role over when the admin leaves (E-FR-06)', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    await createBudget(alice, 'Home');
    await openBudget(alice, 'Home');
    checkInvitation(bob, await createLink(alice));
    await bob.ui.findByText('Invitation to join “Home”.');
    fireEvent.click(bob.ui.getByRole('button', { name: 'Accept invitation' }));
    await bob.ui.findByText('Home (MEMBER)');
    await openBudget(bob, 'Home');

    // Admin leaves: Bob becomes administrator.
    fireEvent.click(alice.ui.getByRole('button', { name: 'Leave budget' }));
    expect(
      alice.ui.getByText(/role passes to the member who joined first/),
    ).toBeTruthy();
    fireEvent.click(alice.ui.getByRole('button', { name: 'Confirm leaving' }));
    await alice.ui.findByText('You left “Home”.');
    await waitFor(() => expect(alice.ui.queryByText(/Home \(/)).toBeNull());
    await bob.ui.findByText('Home (ADMIN)');

    // Last member leaves: the budget is deleted.
    fireEvent.click(bob.ui.getByRole('button', { name: 'Open Home' }));
    fireEvent.click(
      await bob.ui.findByRole('button', { name: 'Leave budget' }),
    );
    expect(bob.ui.getByText(/last member/)).toBeTruthy();
    fireEvent.click(bob.ui.getByRole('button', { name: 'Confirm leaving' }));
    await bob.ui.findByText('You left “Home”; the budget was deleted.');
    await bob.ui.findByText(/not a member of any budget yet/);
  });

  it('saves currency preferences and rejects invalid ones', async () => {
    const alice = await signIn(ALICE);
    fireEvent.change(alice.ui.getByLabelText(/Primary currency/), {
      target: { value: 'usd' },
    });
    fireEvent.click(alice.ui.getByRole('button', { name: 'Save currencies' }));
    await alice.ui.findByText('Currency preferences saved.');

    fireEvent.change(alice.ui.getByLabelText(/Secondary currencies/), {
      target: { value: 'USD' },
    });
    fireEvent.click(alice.ui.getByRole('button', { name: 'Save currencies' }));
    expect((await alice.ui.findByRole('alert')).textContent).toContain(
      'not valid',
    );
  });
});
