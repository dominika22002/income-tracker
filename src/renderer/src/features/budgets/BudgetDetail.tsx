import React, { useCallback, useEffect, useState } from 'react';
import type {
  InvitationView,
  MemberView,
  MyBudgetView,
} from '../../../../shared/contracts';
import { isInvitationExpired } from '../../../../shared/domain/invitation';
import type { AppServices, Session } from '../../backend/ports';
import { describeError } from './errorMessages';
import { useAction, type Notify } from './useAction';

function memberLabel(member: MemberView): string {
  return member.display_name ?? member.email ?? member.user_id;
}

export function BudgetDetail({
  services,
  session,
  budget,
  notify,
  onLeft,
  onAccessLost,
}: {
  services: AppServices;
  session: Session;
  budget: MyBudgetView;
  notify: Notify;
  onLeft: () => void;
  onAccessLost: () => void;
}) {
  const { backend, data } = services;
  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [invitations, setInvitations] = useState<InvitationView[] | null>(null);
  const [email, setEmail] = useState('');
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const { busy, run } = useAction(notify);
  const isAdmin = budget.role === 'ADMIN';

  // A permission error here means the server revoked access (removal).
  const onListenError = useCallback(
    (error: Error) => {
      notify({ type: 'error', message: describeError(error) });
      if ((error as { code?: unknown }).code === 'permission-denied') {
        onAccessLost();
      }
    },
    [notify, onAccessLost],
  );

  useEffect(
    () => data.subscribeMembers(budget.budget_id, setMembers, onListenError),
    [data, budget.budget_id, onListenError],
  );

  useEffect(() => {
    if (!isAdmin) return undefined;
    return data.subscribeInvitations(
      budget.budget_id,
      setInvitations,
      onListenError,
    );
  }, [data, isAdmin, budget.budget_id, onListenError]);

  const isLastMember = (members?.length ?? 0) <= 1;

  async function createInvitation() {
    const created = await run(
      () =>
        backend.createInvitation({
          budget_id: budget.budget_id,
          ...(email.trim() ? { invitee_email: email.trim() } : {}),
        }),
      () => 'Invitation link created. Copy it now; it is shown only once.',
    );
    if (created) {
      setCreatedLink(created.link);
      setEmail('');
    }
  }

  return (
    <section aria-label={`Budget ${budget.name}`}>
      <h3>{budget.name}</h3>
      <h4>Members</h4>
      {members === null && <p>Loading members…</p>}
      <ul aria-label="Members">
        {(members ?? []).map((member) => (
          <li key={member.membership_id}>
            {memberLabel(member)} ({member.role})
            {isAdmin && member.user_id !== session.uid && (
              <>
                {' '}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        backend.removeMember({
                          budget_id: budget.budget_id,
                          membership_id: member.membership_id,
                        }),
                      () => `${memberLabel(member)} was removed.`,
                    )
                  }
                >
                  Remove {memberLabel(member)}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      {isAdmin && (
        <div>
          <h4>Invitations</h4>
          {invitations === null && <p>Loading invitations…</p>}
          <label>
            Invitee e-mail (optional){' '}
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => void createInvitation()}
          >
            Create invitation link
          </button>
          {createdLink && (
            <p>
              Invitation link:{' '}
              <code data-testid="invitation-link">{createdLink}</code>
            </p>
          )}
          <ul aria-label="Invitations">
            {(invitations ?? []).map((invitation) => {
              const expired =
                invitation.status === 'PENDING' &&
                isInvitationExpired(
                  new Date(invitation.expires_at),
                  new Date(),
                );
              const status = expired ? 'EXPIRED' : invitation.status;
              return (
                <li key={invitation.invitation_id}>
                  {status}
                  {invitation.invitee_email
                    ? ` — ${invitation.invitee_email}`
                    : ''}{' '}
                  (expires {invitation.expires_at.slice(0, 10)})
                  {status === 'PENDING' && (
                    <>
                      {' '}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              backend.cancelInvitation(
                                invitation.invitation_id,
                              ),
                            () => 'Invitation cancelled.',
                          )
                        }
                      >
                        Cancel invitation
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!confirmLeave ? (
        <button type="button" onClick={() => setConfirmLeave(true)}>
          Leave budget
        </button>
      ) : (
        <div>
          <p>
            {isLastMember
              ? 'You are the last member: leaving deletes this budget and all its data. Local backup files are outside the app’s control and must be deleted separately.'
              : isAdmin
                ? 'You are the administrator: the role passes to the member who joined first.'
                : 'You will lose access to this budget. Your transactions stay in it.'}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                () => backend.leaveBudget(budget.budget_id),
                (result) =>
                  result.budget_deleted
                    ? `You left “${budget.name}”; the budget was deleted.`
                    : `You left “${budget.name}”.`,
              ).then((result) => result && onLeft())
            }
          >
            Confirm leaving
          </button>{' '}
          <button type="button" onClick={() => setConfirmLeave(false)}>
            Stay in budget
          </button>
        </div>
      )}
    </section>
  );
}
