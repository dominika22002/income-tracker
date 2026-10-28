import type { Transaction } from 'firebase-admin/firestore';
import type {
  CreateInvitationResult,
  InvitationPreview,
  InvitationRecord,
  JoinBudgetResult,
} from '../shared/contracts';
import { activeMemberPath, COLLECTIONS } from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import {
  assertInvitationTransition,
  assertInviteeAllowed,
  computeExpiresAt,
  evaluateInvitationUse,
} from '../shared/domain/invitation';
import { assertNoActiveMembership } from '../shared/domain/membership';
import {
  INVITATION_LINK_PREFIX,
  isInvitationToken,
  isUuid,
  validateCreateInvitationRequest,
} from '../shared/validators';
import { requireActiveAdmin } from './access';
import {
  activeMemberToData,
  invitationFromSnapshot,
  invitationToData,
  membershipToData,
} from './converters';
import { requireCaller, type Caller, type ServerDeps } from './context';
import { generateInvitationToken, hashInvitationToken } from './tokens';

const invitationPath = (id: string) => `${COLLECTIONS.invitations}/${id}`;
const tokenPath = (hash: string) => `${COLLECTIONS.invitationTokens}/${hash}`;

/**
 * Creates a single-use invitation link. Only the SHA-256 hash of the token is
 * persisted; the token is returned once. The token index document doubles as
 * the uniqueness constraint on `token_hash` (`create` fails on a duplicate).
 */
export async function createInvitation(
  deps: ServerDeps,
  caller: Caller | null,
  request: unknown,
): Promise<CreateInvitationResult> {
  const { uid } = requireCaller(caller);
  const validated = validateCreateInvitationRequest(request);
  if (!validated) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid invitation request.');
  }

  const invitationId = validated.invitation_id ?? deps.newId();
  const token = generateInvitationToken();
  const tokenHash = hashInvitationToken(token);
  const invitationRef = deps.db.doc(invitationPath(invitationId));
  const tokenRef = deps.db.doc(tokenPath(tokenHash));

  const expiresAt = await deps.db.runTransaction(async (tx) => {
    const admin = await requireActiveAdmin(deps, tx, validated.budget_id, uid);
    const existing = await tx.get(invitationRef);
    if (existing.exists) {
      throw new DomainError('ALREADY_EXISTS');
    }

    const createdAt = deps.now();
    const expires = computeExpiresAt(createdAt);
    tx.create(
      invitationRef,
      invitationToData({
        budget_id: validated.budget_id,
        invited_by_membership_id: admin.membership_id,
        invitee_email: validated.invitee_email ?? null,
        token_hash: tokenHash,
        status: 'PENDING',
        created_at: createdAt,
        expires_at: expires,
      }),
    );
    tx.create(tokenRef, {
      invitation_id: invitationId,
      budget_id: validated.budget_id,
    });
    return expires;
  });

  return {
    invitation_id: invitationId,
    token,
    link: `${INVITATION_LINK_PREFIX}${token}`,
    expires_at: expiresAt.toISOString(),
  };
}

async function loadInvitationByToken(
  deps: ServerDeps,
  tx: Transaction,
  token: unknown,
): Promise<InvitationRecord> {
  if (!isInvitationToken(token)) {
    throw new DomainError('INVALID_ARGUMENT', 'Malformed invitation token.');
  }
  const tokenSnap = await tx.get(
    deps.db.doc(tokenPath(hashInvitationToken(token))),
  );
  if (!tokenSnap.exists) {
    throw new DomainError('NOT_FOUND');
  }
  const invitationSnap = await tx.get(
    deps.db.doc(invitationPath(tokenSnap.get('invitation_id'))),
  );
  if (!invitationSnap.exists) {
    throw new DomainError('NOT_FOUND');
  }
  return invitationFromSnapshot(invitationSnap);
}

export async function previewInvitation(
  deps: ServerDeps,
  caller: Caller | null,
  token: unknown,
): Promise<InvitationPreview> {
  requireCaller(caller);
  return deps.db.runTransaction(async (tx) => {
    const invitation = await loadInvitationByToken(deps, tx, token);
    const usability = evaluateInvitationUse(invitation, deps.now());
    const status = usability === 'expired' ? 'EXPIRED' : invitation.status;
    const budgetSnap = await tx.get(
      deps.db.doc(`${COLLECTIONS.budgets}/${invitation.budget_id}`),
    );

    return {
      invitation_id: invitation.invitation_id,
      budget_id: invitation.budget_id,
      budget_name:
        usability === 'usable' && budgetSnap.exists
          ? (budgetSnap.get('name') as string)
          : null,
      status,
      expires_at: invitation.expires_at.toISOString(),
      restricted_to_email: invitation.invitee_email !== null,
    };
  });
}

type Outcome<T> = { kind: 'done'; value: T } | { kind: 'expired' };

/** Persists the EXPIRED status; the caller reports the error after commit. */
function expire(
  deps: ServerDeps,
  tx: Transaction,
  invitation: InvitationRecord,
): Outcome<never> {
  if (invitation.status === 'PENDING') {
    assertInvitationTransition('PENDING', 'EXPIRED');
    tx.update(deps.db.doc(invitationPath(invitation.invitation_id)), {
      status: 'EXPIRED',
    });
  }
  return { kind: 'expired' };
}

function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.kind === 'expired') {
    throw new DomainError('INVITATION_EXPIRED');
  }
  return outcome.value;
}

/**
 * Consumes the link and creates the membership in one transaction. Concurrent
 * attempts on the same invitation serialize on the invitation document, so
 * exactly one succeeds.
 */
export async function acceptInvitation(
  deps: ServerDeps,
  caller: Caller | null,
  token: unknown,
): Promise<JoinBudgetResult> {
  const { uid, email, emailVerified, displayName } = requireCaller(caller);

  const outcome = await deps.db.runTransaction(
    async (tx): Promise<Outcome<JoinBudgetResult>> => {
      const invitation = await loadInvitationByToken(deps, tx, token);
      const now = deps.now();
      const usability = evaluateInvitationUse(invitation, now);
      if (usability === 'not_pending') {
        throw new DomainError('INVITATION_NOT_PENDING');
      }
      if (usability === 'expired') {
        return expire(deps, tx, invitation);
      }

      assertInviteeAllowed(invitation.invitee_email, { email, emailVerified });

      const budgetSnap = await tx.get(
        deps.db.doc(`${COLLECTIONS.budgets}/${invitation.budget_id}`),
      );
      if (!budgetSnap.exists) {
        throw new DomainError('NOT_FOUND');
      }
      const accessRef = deps.db.doc(
        activeMemberPath(invitation.budget_id, uid),
      );
      const accessSnap = await tx.get(accessRef);
      assertNoActiveMembership(
        accessSnap.exists ? [accessSnap.get('membership_id') as string] : [],
      );
      assertInvitationTransition('PENDING', 'ACCEPTED');
      const membershipId = deps.newId();
      tx.update(deps.db.doc(invitationPath(invitation.invitation_id)), {
        status: 'ACCEPTED',
      });
      tx.create(
        deps.db.doc(`${COLLECTIONS.memberships}/${membershipId}`),
        membershipToData({
          budget_id: invitation.budget_id,
          user_id: uid,
          role: 'MEMBER',
          status: 'ACTIVE',
          joined_at: now,
          ended_at: null,
        }),
      );
      tx.create(
        accessRef,
        activeMemberToData({
          membership_id: membershipId,
          role: 'MEMBER',
          joined_at: now,
          display_name: displayName ?? null,
          email: email ?? null,
        }),
      );
      return {
        kind: 'done',
        value: {
          budget_id: invitation.budget_id,
          membership_id: membershipId,
        },
      };
    },
  );
  return unwrap(outcome);
}

export async function declineInvitation(
  deps: ServerDeps,
  caller: Caller | null,
  token: unknown,
): Promise<void> {
  const { email, emailVerified } = requireCaller(caller);

  const outcome = await deps.db.runTransaction(
    async (tx): Promise<Outcome<null>> => {
      const invitation = await loadInvitationByToken(deps, tx, token);
      const usability = evaluateInvitationUse(invitation, deps.now());
      if (usability === 'not_pending') {
        throw new DomainError('INVITATION_NOT_PENDING');
      }
      if (usability === 'expired') {
        return expire(deps, tx, invitation);
      }

      assertInviteeAllowed(invitation.invitee_email, { email, emailVerified });
      assertInvitationTransition('PENDING', 'DECLINED');
      tx.update(deps.db.doc(invitationPath(invitation.invitation_id)), {
        status: 'DECLINED',
      });
      return { kind: 'done', value: null };
    },
  );
  unwrap(outcome);
}

export async function cancelInvitation(
  deps: ServerDeps,
  caller: Caller | null,
  invitationId: unknown,
): Promise<void> {
  const { uid } = requireCaller(caller);
  if (!isUuid(invitationId)) {
    throw new DomainError('INVALID_ARGUMENT', 'Malformed invitation id.');
  }

  const outcome = await deps.db.runTransaction(
    async (tx): Promise<Outcome<null>> => {
      const snap = await tx.get(deps.db.doc(invitationPath(invitationId)));
      if (!snap.exists) {
        throw new DomainError('NOT_FOUND');
      }
      const invitation = invitationFromSnapshot(snap);
      await requireActiveAdmin(deps, tx, invitation.budget_id, uid);

      const usability = evaluateInvitationUse(invitation, deps.now());
      if (usability === 'not_pending') {
        throw new DomainError('INVITATION_NOT_PENDING');
      }
      if (usability === 'expired') {
        return expire(deps, tx, invitation);
      }

      assertInvitationTransition('PENDING', 'CANCELLED');
      tx.update(deps.db.doc(invitationPath(invitation.invitation_id)), {
        status: 'CANCELLED',
      });
      return { kind: 'done', value: null };
    },
  );
  unwrap(outcome);
}
