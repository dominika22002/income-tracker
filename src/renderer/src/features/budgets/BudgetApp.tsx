import React, { useCallback, useEffect, useState } from 'react';
import type {
  InvitationPreview,
  MyBudgetView,
  TransactionView,
  UserPreferencesRecord,
} from '../../../../shared/contracts';
import { parseInvitationInput } from '../../../../shared/validators';
import type { AppServices, Session } from '../../backend/ports';
import { BudgetDetail } from './BudgetDetail';
import { describeError } from './errorMessages';
import { useAction, type Notice, type Notify } from './useAction';
import { StatementCsvPreview } from '../imports/StatementCsvPreview';
import { TransactionsWorkspace } from './TransactionsWorkspace';
import { HiddenTransactionsNotice } from './HiddenTransactionsNotice';
import { transactionsVisibleToMember } from '../../../../shared/domain/transactionFeatures';
import { ReportsWorkspace } from './ReportsWorkspace';

export type AppView =
  'overview' | 'transactions' | 'reports' | 'budgets' | 'imports' | 'settings';

export function BudgetApp({
  services,
  requireAuth = true,
  activeView,
  onViewChange,
}: {
  services: AppServices;
  requireAuth?: boolean;
  activeView?: AppView;
  onViewChange?: (view: AppView) => void;
}) {
  const { auth } = services;
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(
    () =>
      auth.subscribe(setSession, (error) => {
        if (!requireAuth) setSession(null);
        setNotice({ type: 'error', message: describeError(error) });
      }),
    [auth, requireAuth],
  );

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
    <section
      className={activeView ? 'budget-app-shell' : 'card feature-panel'}
      aria-label={activeView ? viewTitle(activeView) : 'Budgets'}
      id={activeView ? undefined : 'budget-management'}
    >
      {!activeView && <h2>Budgets</h2>}
      {session === undefined && <p>Checking session…</p>}
      {session === null && (
        <section className="welcome-panel dashboard-card">
          <p className="eyebrow">INCOME TRACKER</p>
          <h1>Twoje finanse w jednym miejscu</h1>
          <p>Sign in to see your budgets.</p>
          <button type="button" onClick={handleSignIn}>
            {requireAuth ? 'Sign in with Google' : 'Spróbuj ponownie'}
          </button>
        </section>
      )}
      {session && (
        <SignedIn
          key={session.uid}
          services={services}
          session={session}
          onSignOut={handleSignOut}
          notify={setNotice}
          requireAuth={requireAuth}
          activeView={activeView}
          onViewChange={onViewChange}
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
  requireAuth,
  activeView,
  onViewChange,
}: {
  services: AppServices;
  session: Session;
  onSignOut: () => void;
  notify: Notify;
  requireAuth: boolean;
  activeView?: AppView;
  onViewChange?: (view: AppView) => void;
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

  const createBudget = (name: string) =>
    run(
      () => backend.createBudget({ name }),
      () => `Budget “${name}” created.`,
    );

  const pageTitle = activeView ? viewTitle(activeView) : undefined;

  return activeView === undefined ? (
    <LegacyBudgetView
      services={services}
      session={session}
      onSignOut={onSignOut}
      notify={notify}
      requireAuth={requireAuth}
      ready={ready}
      preferences={preferences}
      budgets={budgets}
      selected={selected}
      busy={busy}
      confirmDelete={confirmDelete}
      setConfirmDelete={setConfirmDelete}
      onCreateBudget={createBudget}
      onSelectBudget={setSelectedId}
      onBudgetLeft={() => setSelectedId(null)}
      onAccessLost={handleAccessLost}
      onSavePreferences={async (primary, secondary) => {
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
      onDeleteProfile={() =>
        run(
          () => backend.deleteMyProfile(),
          () => 'Your profile was deleted.',
        )
      }
    />
  ) : (
    <RoutedBudgetView
      view={activeView}
      title={pageTitle ?? ''}
      services={services}
      session={session}
      onSignOut={onSignOut}
      onViewChange={onViewChange}
      notify={notify}
      requireAuth={requireAuth}
      ready={ready}
      preferences={preferences}
      budgets={budgets}
      selected={selected}
      busy={busy}
      confirmDelete={confirmDelete}
      setConfirmDelete={setConfirmDelete}
      onCreateBudget={createBudget}
      onSelectBudget={setSelectedId}
      onBudgetLeft={() => setSelectedId(null)}
      onAccessLost={handleAccessLost}
      onSavePreferences={async (primary, secondary) => {
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
      onDeleteProfile={() =>
        run(
          () => backend.deleteMyProfile(),
          () => 'Your profile was deleted.',
        )
      }
    />
  );
}

type BudgetViewProps = {
  services: AppServices;
  session: Session;
  onSignOut: () => void;
  notify: Notify;
  requireAuth: boolean;
  ready: boolean;
  preferences: UserPreferencesRecord | null;
  budgets: MyBudgetView[] | null;
  selected: MyBudgetView | undefined;
  busy: boolean;
  confirmDelete: boolean;
  setConfirmDelete: (value: boolean) => void;
  onCreateBudget: (name: string) => Promise<unknown>;
  onSelectBudget: (budgetId: string) => void;
  onBudgetLeft: () => void;
  onAccessLost: () => void;
  onSavePreferences: (primary: string, secondary: string[]) => Promise<void>;
  onDeleteProfile: () => Promise<unknown>;
};

function LegacyBudgetView({
  services,
  session,
  onSignOut,
  notify,
  requireAuth,
  ready,
  preferences,
  budgets,
  selected,
  busy,
  confirmDelete,
  setConfirmDelete,
  onCreateBudget,
  onSelectBudget,
  onBudgetLeft,
  onAccessLost,
  onSavePreferences,
  onDeleteProfile,
}: BudgetViewProps) {
  return (
    <div>
      <p>
        Signed in as{' '}
        <strong>{session.displayName ?? session.email ?? session.uid}</strong>
        {requireAuth && (
          <>
            {' '}
            <button type="button" onClick={onSignOut}>
              Sign out
            </button>
          </>
        )}
      </p>
      {!ready && <p>Preparing your profile…</p>}
      {ready && (
        <>
          <CreateBudgetForm onCreate={onCreateBudget} busy={busy} />
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
                    onClick={() => onSelectBudget(budget.budget_id)}
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
              onLeft={onBudgetLeft}
              onAccessLost={onAccessLost}
            />
          )}
          {budgets !== null && (
            <StatementCsvPreview services={services} budgets={budgets} />
          )}
          <PreferencesForm
            preferences={preferences}
            busy={busy}
            onSave={onSavePreferences}
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
                onClick={() => void onDeleteProfile()}
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

function RoutedBudgetView({
  view,
  title,
  onViewChange,
  ...props
}: BudgetViewProps & {
  view: AppView;
  title: string;
  onViewChange?: (view: AppView) => void;
}) {
  const {
    services,
    session,
    onSignOut,
    notify,
    requireAuth,
    ready,
    preferences,
    budgets,
    selected,
    busy,
    confirmDelete,
    setConfirmDelete,
    onCreateBudget,
    onSelectBudget,
    onBudgetLeft,
    onAccessLost,
    onSavePreferences,
    onDeleteProfile,
  } = props;

  const description = {
    overview: 'Najważniejsze informacje o Twoich budżetach i danych.',
    transactions: 'Sprawdź transakcje zapisane w wybranym budżecie.',
    reports: 'Podsumowania, limity i oszczędności w wybranym budżecie.',
    budgets: 'Zarządzaj budżetami, członkostwem i zaproszeniami.',
    imports: 'Wczytaj wyciąg lokalnie i sprawdź dane przed zatwierdzeniem.',
    settings: 'Dostosuj preferencje konta i waluty.',
  }[view];

  return (
    <div className="signed-in-app">
      <header className="page-heading">
        <div className="page-heading-copy">
          <p className="eyebrow">INCOME TRACKER</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div className="page-actions">
          <div className="account-summary">
            <span className="account-avatar" aria-hidden="true">
              {(session.displayName ?? session.email ?? 'U')
                .slice(0, 1)
                .toUpperCase()}
            </span>
            <span className="account-name">
              {session.displayName ?? session.email ?? session.uid}
            </span>
            {requireAuth && (
              <button
                className="button-secondary"
                type="button"
                onClick={onSignOut}
              >
                Wyloguj
              </button>
            )}
          </div>
          {view === 'overview' && (
            <button type="button" onClick={() => onViewChange?.('imports')}>
              Importuj plik
            </button>
          )}
        </div>
      </header>

      {!ready && (
        <section className="dashboard-card loading-card" role="status">
          Przygotowywanie profilu…
        </section>
      )}

      {ready && view === 'overview' && (
        <OverviewDashboard
          data={services.data}
          budgets={budgets}
          selectedBudgetId={selected?.budget_id}
          onSelectBudget={onSelectBudget}
          onOpenBudget={(budgetId) => {
            onSelectBudget(budgetId);
            onViewChange?.('budgets');
          }}
          onViewChange={onViewChange}
        />
      )}

      {ready && view === 'budgets' && (
        <div className="budget-management-grid">
          <section className="dashboard-card budget-list-panel">
            <div className="card-heading">
              <div>
                <p className="eyebrow">WSPÓŁDZIELONE FINANSE</p>
                <h2>Moje budżety</h2>
              </div>
              <span className="count-badge">
                {budgets === null ? '…' : budgets.length}
              </span>
            </div>
            <CreateBudgetForm onCreate={onCreateBudget} busy={busy} />
            <div className="section-divider" />
            <JoinInvitation services={services} notify={notify} />
            <div className="section-divider" />
            {budgets === null ? (
              <p>Ładowanie budżetów…</p>
            ) : budgets.length === 0 ? (
              <div className="empty-state compact-empty-state">
                <h3>Nie masz jeszcze budżetu</h3>
                <p>
                  Utwórz budżet lub dołącz za pomocą otrzymanego zaproszenia.
                </p>
              </div>
            ) : (
              <ul className="budget-list" aria-label="My budgets">
                {budgets.map((budget) => (
                  <li
                    className={
                      selected?.budget_id === budget.budget_id
                        ? 'budget-list-item is-selected'
                        : 'budget-list-item'
                    }
                    key={budget.budget_id}
                  >
                    <div className="budget-avatar" aria-hidden="true">
                      {budget.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="budget-list-copy">
                      <strong>{budget.name}</strong>
                      <span>
                        {budget.role === 'ADMIN' ? 'Administrator' : 'Członek'}
                      </span>
                    </div>
                    <button
                      className="button-secondary"
                      type="button"
                      onClick={() => onSelectBudget(budget.budget_id)}
                    >
                      Otwórz
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="dashboard-card budget-detail-panel">
            {selected ? (
              <BudgetDetail
                key={selected.budget_id}
                services={services}
                session={session}
                budget={selected}
                notify={notify}
                onLeft={onBudgetLeft}
                onAccessLost={onAccessLost}
              />
            ) : (
              <div className="empty-state detail-empty-state">
                <span className="empty-state-icon" aria-hidden="true">
                  ◫
                </span>
                <h2>Wybierz budżet</h2>
                <p>
                  Otwórz jeden z budżetów, aby zobaczyć członków i zaproszenia.
                </p>
              </div>
            )}
          </section>
        </div>
      )}

      {ready && view === 'transactions' && (
        <TransactionsWorkspace
          services={services}
          budgets={budgets}
          selectedBudgetId={selected?.budget_id}
          onSelectBudget={onSelectBudget}
        />
      )}

      {ready && view === 'reports' && (
        <ReportsWorkspace
          services={services}
          budgets={budgets}
          selectedBudgetId={selected?.budget_id}
          onSelectBudget={onSelectBudget}
          preferences={preferences}
        />
      )}

      {ready &&
        view === 'imports' &&
        (budgets === null ? (
          <section className="dashboard-card loading-card" role="status">
            Ładowanie budżetów…
          </section>
        ) : (
          <StatementCsvPreview
            services={services}
            budgets={budgets}
            onImportSuccess={onSelectBudget}
          />
        ))}

      {ready && view === 'settings' && (
        <div className="settings-grid">
          <section className="dashboard-card">
            <p className="eyebrow">PREFERENCJE</p>
            <h2>Waluty</h2>
            <PreferencesForm
              preferences={preferences}
              busy={busy}
              onSave={onSavePreferences}
            />
          </section>
          <section className="dashboard-card danger-panel">
            <p className="eyebrow">STREFA RYZYKOWNA</p>
            <h2>Usuwanie profilu</h2>
            {!confirmDelete ? (
              <>
                <p>
                  Usunięcie profilu zakończy członkostwo we wszystkich
                  budżetach. Transakcje pozostaną w budżetach.
                </p>
                <button
                  className="button-danger"
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                >
                  Usuń profil
                </button>
              </>
            ) : (
              <>
                <p>
                  Ta operacja jest trwała. Kopie zapasowe zapisane na tym
                  komputerze nie zostaną usunięte.
                </p>
                <div className="actions">
                  <button
                    className="button-danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void onDeleteProfile()}
                  >
                    Potwierdź usunięcie
                  </button>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Zachowaj profil
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function OverviewDashboard({
  data,
  budgets,
  selectedBudgetId,
  onSelectBudget,
  onOpenBudget,
  onViewChange,
}: {
  data: Pick<AppServices['data'], 'subscribeTransactions'>;
  budgets: MyBudgetView[] | null;
  selectedBudgetId?: string;
  onSelectBudget: (budgetId: string) => void;
  onOpenBudget: (budgetId: string) => void;
  onViewChange?: (view: AppView) => void;
}) {
  return (
    <div className="dashboard-grid">
      <section className="dashboard-card balance-card">
        <div className="card-heading">
          <div className="card-title-wrap">
            <span className="dashboard-icon" aria-hidden="true">
              ◉
            </span>
            <h2>Saldo</h2>
          </div>
          <span className="unavailable-label">Niedostępne</span>
        </div>
        <p className="dashboard-value" aria-label="Saldo niedostępne">
          —
        </p>
        <p className="card-description">
          Aplikacja nie udostępnia jeszcze podsumowania salda ani transakcji.
        </p>
        <div className="dashboard-actions">
          <button type="button" onClick={() => onViewChange?.('imports')}>
            Importuj CSV
          </button>
          <button
            className="button-secondary"
            type="button"
            onClick={() => onViewChange?.('budgets')}
          >
            Zobacz budżety
          </button>
        </div>
      </section>

      <SummaryCard title="Przychody" icon="↗" />
      <SummaryCard title="Wydatki" icon="↘" />

      <section className="dashboard-card budgets-overview-card">
        <div className="card-heading">
          <div className="card-title-wrap">
            <span className="dashboard-icon" aria-hidden="true">
              ◈
            </span>
            <h2>Moje budżety</h2>
          </div>
          <button
            className="text-button"
            type="button"
            onClick={() => onViewChange?.('budgets')}
          >
            Wszystkie budżety
          </button>
        </div>
        {budgets === null ? (
          <p>Ładowanie budżetów…</p>
        ) : budgets.length === 0 ? (
          <div className="dashboard-empty">
            <p>Nie masz jeszcze budżetu.</p>
            <button
              className="button-secondary"
              type="button"
              onClick={() => onViewChange?.('budgets')}
            >
              Utwórz pierwszy budżet
            </button>
          </div>
        ) : (
          <ul className="overview-budget-list">
            {budgets.slice(0, 4).map((budget) => (
              <li key={budget.budget_id}>
                <span className="budget-avatar" aria-hidden="true">
                  {budget.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="overview-budget-copy">
                  <strong>{budget.name}</strong>
                  <small>
                    {budget.role === 'ADMIN' ? 'Administrator' : 'Członek'}
                  </small>
                </span>
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => onOpenBudget(budget.budget_id)}
                >
                  Otwórz
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <TransactionsPanel
        compact
        data={data}
        budgets={budgets}
        selectedBudgetId={selectedBudgetId}
        onSelectBudget={onSelectBudget}
        onViewChange={onViewChange}
      />

      <section className="dashboard-card import-promo-card">
        <span className="promo-icon" aria-hidden="true">
          ⇧
        </span>
        <p className="eyebrow">IMPORT WYCIĄGU</p>
        <h2>Dodaj dane z CSV</h2>
        <p>
          Plik jest parsowany lokalnie. Dane zobaczysz i zatwierdzisz przed
          wysłaniem.
        </p>
        <button
          className="promo-button"
          type="button"
          onClick={() => onViewChange?.('imports')}
        >
          Otwórz import
        </button>
      </section>
    </div>
  );
}

export function TransactionsPanel({
  data,
  budgets,
  selectedBudgetId,
  onSelectBudget,
  onViewChange,
  compact = false,
}: {
  data: Pick<AppServices['data'], 'subscribeTransactions'>;
  budgets: MyBudgetView[] | null;
  selectedBudgetId?: string;
  onSelectBudget?: (budgetId: string) => void;
  onViewChange?: (view: AppView) => void;
  compact?: boolean;
}) {
  const [localBudgetId, setLocalBudgetId] = useState('');
  const budgetId =
    (selectedBudgetId &&
    budgets?.some((budget) => budget.budget_id === selectedBudgetId)
      ? selectedBudgetId
      : undefined) ??
    (localBudgetId &&
    budgets?.some((budget) => budget.budget_id === localBudgetId)
      ? localBudgetId
      : undefined) ??
    budgets?.[0]?.budget_id ??
    '';
  const viewerMembershipId =
    budgets?.find((budget) => budget.budget_id === budgetId)?.membership_id ??
    '';
  const [snapshot, setSnapshot] = useState<{
    budgetId: string;
    transactions: TransactionView[];
  } | null>(null);
  const [failure, setFailure] = useState<{
    budgetId: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!budgetId || !viewerMembershipId) return undefined;
    return data.subscribeTransactions(
      budgetId,
      viewerMembershipId,
      (transactions) => {
        setSnapshot({ budgetId, transactions });
        setFailure(null);
      },
      (error) => setFailure({ budgetId, message: describeError(error) }),
    );
  }, [data, budgetId, viewerMembershipId]);

  const transactions =
    snapshot?.budgetId === budgetId ? snapshot.transactions : null;
  const visibleTransactions = transactions
    ? transactionsVisibleToMember(transactions, viewerMembershipId, new Date())
    : null;
  const errorMessage = failure?.budgetId === budgetId ? failure.message : null;
  const displayedTransactions =
    compact && visibleTransactions
      ? visibleTransactions.slice(0, 5)
      : visibleTransactions;

  return (
    <section
      className={`dashboard-card transactions-panel${compact ? ' transactions-panel-compact' : ''}`}
      aria-label={compact ? 'Ostatnie transakcje' : 'Transakcje budżetu'}
    >
      <div className="card-heading">
        <div>
          <p className="eyebrow">DANE Z BUDŻETU</p>
          <h2>{compact ? 'Ostatnie transakcje' : 'Transakcje'}</h2>
        </div>
        {compact && onViewChange && (
          <button
            className="text-button"
            type="button"
            onClick={() => onViewChange('transactions')}
          >
            Wszystkie transakcje
          </button>
        )}
      </div>

      {budgets === null ? (
        <p role="status">Ładowanie budżetów…</p>
      ) : budgets.length === 0 ? (
        <p>Utwórz budżet, aby importować i przeglądać transakcje.</p>
      ) : (
        <>
          <label className="transaction-budget-select">
            Budżet{' '}
            <select
              aria-label="Budżet transakcji"
              value={budgetId}
              onChange={(event) => {
                setLocalBudgetId(event.target.value);
                onSelectBudget?.(event.target.value);
              }}
            >
              {budgets.map((budget) => (
                <option key={budget.budget_id} value={budget.budget_id}>
                  {budget.name}
                </option>
              ))}
            </select>
          </label>

          {errorMessage ? (
            <p role="alert">{errorMessage}</p>
          ) : transactions === null ? (
            <p role="status">Ładowanie transakcji…</p>
          ) : transactions.length === 0 ? (
            <div className="empty-state">
              <p>Brak transakcji w tym budżecie.</p>
              {onViewChange && (
                <button type="button" onClick={() => onViewChange('imports')}>
                  Importuj plik CSV
                </button>
              )}
            </div>
          ) : (
            <>
              <HiddenTransactionsNotice transactions={transactions} />
              {displayedTransactions?.length === 0 ? (
                <p>Brak widocznych transakcji.</p>
              ) : (
                <div className="transaction-table-scroll">
                  <table className="transaction-table">
                    <thead>
                      <tr>
                        <th scope="col">Data</th>
                        <th scope="col">Opis</th>
                        <th scope="col">Konto</th>
                        <th scope="col">Typ</th>
                        <th scope="col" className="transaction-amount">
                          Kwota
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedTransactions?.map((transaction) => (
                        <tr key={transaction.transaction_id}>
                          <td>
                            <time dateTime={transaction.operation_date}>
                              {formatTransactionDate(
                                transaction.operation_date,
                              )}
                            </time>
                          </td>
                          <td>{transaction.description}</td>
                          <td>
                            {transaction.account_label ?? 'Konto niedostępne'}
                          </td>
                          <td>{transactionTypeLabel(transaction.type)}</td>
                          <td className="transaction-amount">
                            {formatTransactionAmount(
                              transaction.amount,
                              transaction.currency,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {compact &&
                visibleTransactions !== null &&
                visibleTransactions.length > 5 &&
                onViewChange && (
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => onViewChange('transactions')}
                  >
                    Pokaż wszystkie ({visibleTransactions.length})
                  </button>
                )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function formatTransactionDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('pl-PL').format(
    new Date(year, month - 1, day),
  );
}

function formatTransactionAmount(amount: string, currency: string): string {
  const value = Number(amount);
  const formatted = Number.isFinite(value)
    ? new Intl.NumberFormat('pl-PL', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(value)
    : amount;
  return `${formatted} ${currency}`;
}

function transactionTypeLabel(type: TransactionView['type']): string {
  switch (type) {
    case 'INCOME':
      return 'Przychód';
    case 'EXPENSE':
      return 'Wydatek';
    case 'TRANSFER':
      return 'Transfer';
  }
}

function SummaryCard({ title, icon }: { title: string; icon: string }) {
  return (
    <section className="dashboard-card compact-metric-card">
      <div className="card-title-wrap">
        <span className="dashboard-icon" aria-hidden="true">
          {icon}
        </span>
        <h2>{title}</h2>
      </div>
      <p className="compact-dashboard-value">—</p>
      <p className="card-description">
        Podsumowania transakcji nie są dostępne.
      </p>
    </section>
  );
}

function viewTitle(view: AppView): string {
  switch (view) {
    case 'overview':
      return 'Przegląd';
    case 'transactions':
      return 'Transakcje';
    case 'reports':
      return 'Raporty';
    case 'budgets':
      return 'Budżety';
    case 'imports':
      return 'Importy';
    case 'settings':
      return 'Ustawienia';
  }
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
