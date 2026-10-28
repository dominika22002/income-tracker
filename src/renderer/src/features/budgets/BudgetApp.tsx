import React, { useCallback, useEffect, useState } from 'react';
import type {
  InvitationPreview,
  MyBudgetView,
  UserPreferencesRecord,
} from '../../../../shared/contracts';
import { parseInvitationInput } from '../../../../shared/validators';
import type { AppServices, Session } from '../../backend/ports';
import { BudgetDetail } from './BudgetDetail';
import { describeError } from './errorMessages';
import { useAction, type Notice, type Notify } from './useAction';
import { StatementCsvPreview } from '../imports/StatementCsvPreview';

export function BudgetApp({ services }: { services: AppServices }) {
  const { auth } = services;
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => auth.subscribe(setSession), [auth]);

  async function handleSignIn() {
    setNotice(null);
    try {
      await auth.signIn();
    } catch (error) {
      setNotice({ type: 'error', message: describeError(error) });
    }
  }

  async function handleSignOut() {
    try {
      await auth.signOut();
      setNotice(null);
    } catch (error) {
      setNotice({ type: 'error', message: describeError(error) });
    }
  }

  return (
    <section className="card" aria-label="Budgets">
      <h2>Budgets</h2>
      {session === undefined && <p>Checking session…</p>}
      {session === null && (
        <div>
          <p>Sign in to see your budgets.</p>
          <button type="button" onClick={handleSignIn}>
            Sign in with Google
          </button>
        </div>
      )}
      {session && (
        <SignedIn
          key={session.uid}
          services={services}
          session={session}
          onSignOut={handleSignOut}
          notify={setNotice}
        />
      )}
      {notice && (
        <p
          role={notice.type === 'error' ? 'alert' : 'status'}
          className={`status status-${notice.type}`}
        >
          {notice.message}
        </p>
      )}
    </section>
  );
}

function SignedIn({
  services,
  session,
  onSignOut,
  notify,
}: {
  services: AppServices;
  session: Session;
  onSignOut: () => void;
  notify: Notify;
}) {
  const { backend, data } = services;
  const [ready, setReady] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferencesRecord | null>(
    null,
  );
  const [budgets, setBudgets] = useState<MyBudgetView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [listVersion, setListVersion] = useState(0);
  const { busy, run } = useAction(notify);

  useEffect(() => {
    let active = true;
    backend
      .ensureUserProfile()
      .then((prefs) => {
        if (!active) return;
        setPreferences(prefs);
        setReady(true);
      })
      .catch((error: unknown) => {
        if (active) notify({ type: 'error', message: describeError(error) });
      });
    return () => {
      active = false;
    };
  }, [backend, notify]);

  // `listVersion` restarts the subscription after access to a budget was lost.
  useEffect(() => {
    if (!ready) return undefined;
    return data.subscribeMyBudgets(session.uid, setBudgets, (error) =>
      notify({ type: 'error', message: describeError(error) }),
    );
  }, [data, ready, session.uid, notify, listVersion]);

  const handleAccessLost = useCallback(() => {
    setSelectedId(null);
    setBudgets(null);
    setListVersion((version) => version + 1);
  }, []);

  const selected = budgets?.find((budget) => budget.budget_id === selectedId);

  return (
    <div>
      <p>
        Signed in as{' '}
        <strong>{session.displayName ?? session.email ?? session.uid}</strong>{' '}
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </p>
      {!ready && <p>Preparing your profile…</p>}
      {ready && (
        <>
          <CreateBudgetForm
            onCreate={(name) =>
              run(
                () => backend.createBudget({ name }),
                () => `Budget “${name}” created.`,
              )
            }
            busy={busy}
          />
          <JoinInvitation services={services} notify={notify} />
          <h3>My budgets</h3>
          {budgets === null ? (
            <p>Loading budgets…</p>
          ) : budgets.length === 0 ? (
            <p>You are not a member of any budget yet.</p>
          ) : (
            <ul aria-label="My budgets">
              {budgets.map((budget) => (
                <li key={budget.budget_id}>
                  {budget.name} ({budget.role}){' '}
                  <button
                    type="button"
                    onClick={() => setSelectedId(budget.budget_id)}
                  >
                    Open {budget.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selected && (
            <BudgetDetail
              key={selected.budget_id}
              services={services}
              session={session}
              budget={selected}
              notify={notify}
              onLeft={() => setSelectedId(null)}
              onAccessLost={handleAccessLost}
            />
          )}
          {budgets !== null && (
            <StatementCsvPreview services={services} budgets={budgets} />
          )}
          <PreferencesForm
            preferences={preferences}
            busy={busy}
            onSave={async (primary, secondary) => {
              const saved = await run(
                () =>
                  backend.updatePreferences({
                    primary_currency: primary,
                    secondary_currencies: secondary,
                  }),
                () => 'Currency preferences saved.',
              );
              if (saved) setPreferences(saved);
            }}
          />
          <h3>Delete profile</h3>
          {!confirmDelete ? (
            <button type="button" onClick={() => setConfirmDelete(true)}>
              Delete my profile
            </button>
          ) : (
            <div>
              <p>
                This permanently deletes your profile and ends all your
                memberships. Transactions you added stay in the budgets. Backup
                files saved on your computer are not deleted — remove them
                yourself.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => backend.deleteMyProfile(),
                    () => 'Your profile was deleted.',
                  )
                }
              >
                Confirm permanent deletion
              </button>{' '}
              <button type="button" onClick={() => setConfirmDelete(false)}>
                Keep my profile
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CreateBudgetForm({
  onCreate,
  busy,
}: {
  onCreate: (name: string) => Promise<unknown>;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate(name).then((result) => {
          if (result) setName('');
        });
      }}
    >
      <label>
        Budget name{' '}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>{' '}
      <button type="submit" disabled={busy}>
        Create budget
      </button>
    </form>
  );
}

function JoinInvitation({
  services,
  notify,
}: {
  services: AppServices;
  notify: Notify;
}) {
  const { backend } = services;
  const [input, setInput] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const { busy, run } = useAction(notify);

  function reset() {
    setInput('');
    setToken(null);
    setPreview(null);
  }

  async function check() {
    const parsed = parseInvitationInput(input);
    if (!parsed) {
      notify({
        type: 'error',
        message: 'This is not a valid invitation link.',
      });
      return;
    }
    const result = await run(
      () => backend.previewInvitation(parsed),
      () => 'Invitation found.',
    );
    if (result) {
      setToken(parsed);
      setPreview(result);
    }
  }

  const usable = preview?.status === 'PENDING';

  return (
    <div>
      <h3>Join with an invitation</h3>
      <label>
        Invitation link or token{' '}
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
      </label>{' '}
      <button type="button" disabled={busy} onClick={() => void check()}>
        Check invitation
      </button>
      {preview && token && (
        <div>
          {usable ? (
            <>
              <p>Invitation to join “{preview.budget_name}”.</p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => backend.acceptInvitation(token),
                    () => `You joined “${preview.budget_name}”.`,
                  ).then((joined) => joined && reset())
                }
              >
                Accept invitation
              </button>{' '}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => backend.declineInvitation(token),
                    () => 'Invitation declined.',
                  ).then(reset)
                }
              >
                Decline invitation
              </button>
            </>
          ) : (
            <p>
              This invitation can no longer be used (
              {preview.status.toLowerCase()}).
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PreferencesForm({
  preferences,
  busy,
  onSave,
}: {
  preferences: UserPreferencesRecord | null;
  busy: boolean;
  onSave: (primary: string, secondary: string[]) => Promise<void>;
}) {
  const [primary, setPrimary] = useState<string | null>(null);
  const [secondary, setSecondary] = useState<string | null>(null);
  if (!preferences) return null;

  const primaryValue = primary ?? preferences.primary_currency;
  const secondaryValue =
    secondary ?? preferences.secondary_currencies.join(', ');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const list = secondaryValue
          .split(',')
          .map((code) => code.trim().toUpperCase())
          .filter(Boolean);
        void onSave(primaryValue.trim().toUpperCase(), list);
      }}
    >
      <h3>Currencies</h3>
      <label>
        Primary currency{' '}
        <input
          value={primaryValue}
          onChange={(event) => setPrimary(event.target.value)}
        />
      </label>{' '}
      <label>
        Secondary currencies{' '}
        <input
          value={secondaryValue}
          onChange={(event) => setSecondary(event.target.value)}
        />
      </label>{' '}
      <button type="submit" disabled={busy}>
        Save currencies
      </button>
    </form>
  );
}
