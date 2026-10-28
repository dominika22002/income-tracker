import type { InvitationRecord, InvitationStatus } from '../contracts';
import { DomainError } from './errors';

export const INVITATION_VALIDITY_DAYS = 7;
const INVITATION_VALIDITY_MS = INVITATION_VALIDITY_DAYS * 24 * 60 * 60 * 1000;

const INVITATION_TRANSITIONS: Readonly<
  Record<InvitationStatus, readonly InvitationStatus[]>
> = {
  PENDING: ['ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'],
  ACCEPTED: [],
  DECLINED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function canTransitionInvitation(
  from: InvitationStatus,
  to: InvitationStatus,
): boolean {
  return INVITATION_TRANSITIONS[from].includes(to);
}

export function assertInvitationTransition(
  from: InvitationStatus,
  to: InvitationStatus,
): void {
  if (!canTransitionInvitation(from, to)) {
    throw new DomainError(
      'INVALID_TRANSITION',
      `Invitation cannot change from ${from} to ${to}.`,
    );
  }
}

export function computeExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + INVITATION_VALIDITY_MS);
}

/** The invitation is valid strictly before `expires_at`. */
export function isInvitationExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

export type InvitationUsability = 'usable' | 'expired' | 'not_pending';

export function evaluateInvitationUse(
  invitation: Pick<InvitationRecord, 'status' | 'expires_at'>,
  now: Date,
): InvitationUsability {
  if (invitation.status === 'EXPIRED') return 'expired';
  if (invitation.status !== 'PENDING') return 'not_pending';
  return isInvitationExpired(invitation.expires_at, now) ? 'expired' : 'usable';
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** An address-restricted invitation requires a verified, matching e-mail. */
export function assertInviteeAllowed(
  inviteeEmail: string | null,
  auth: { email?: string; emailVerified?: boolean },
): void {
  if (inviteeEmail === null) return;
  if (
    auth.emailVerified !== true ||
    typeof auth.email !== 'string' ||
    normalizeEmail(auth.email) !== normalizeEmail(inviteeEmail)
  ) {
    throw new DomainError('INVITATION_EMAIL_MISMATCH');
  }
}
