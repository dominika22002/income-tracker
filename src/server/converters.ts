import {
  Timestamp,
  type DocumentData,
  type DocumentSnapshot,
} from 'firebase-admin/firestore';
import type {
  AccountRecord,
  BudgetRecord,
  InvitationRecord,
  MembershipRecord,
  MembershipRole,
  UserPreferencesRecord,
  UserRecord,
} from '../shared/contracts';

export function toTimestamp(date: Date): Timestamp {
  return Timestamp.fromDate(date);
}

function toDate(value: unknown): Date {
  if (value instanceof Timestamp) return value.toDate();
  throw new Error('Expected a Firestore timestamp.');
}

function toDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

function data(snapshot: DocumentSnapshot): DocumentData {
  const value = snapshot.data();
  if (!value) throw new Error(`Document ${snapshot.ref.path} does not exist.`);
  return value;
}

export function userToData(user: Omit<UserRecord, 'user_id'>): DocumentData {
  return {
    email: user.email,
    display_name: user.display_name,
    created_at: toTimestamp(user.created_at),
  };
}

export function userFromSnapshot(snapshot: DocumentSnapshot): UserRecord {
  const value = data(snapshot);
  return {
    user_id: snapshot.id,
    email: value.email ?? null,
    display_name: value.display_name ?? null,
    created_at: toDate(value.created_at),
  };
}

export function preferencesToData(
  preferences: Omit<UserPreferencesRecord, 'user_id'>,
): DocumentData {
  return {
    primary_currency: preferences.primary_currency,
    secondary_currencies: preferences.secondary_currencies,
  };
}

export function preferencesFromSnapshot(
  snapshot: DocumentSnapshot,
): UserPreferencesRecord {
  const value = data(snapshot);
  return {
    user_id: snapshot.id,
    primary_currency: value.primary_currency,
    secondary_currencies: [...value.secondary_currencies],
  };
}

export function budgetToData(
  budget: Omit<BudgetRecord, 'budget_id'>,
): DocumentData {
  return {
    name: budget.name,
    created_at: toTimestamp(budget.created_at),
    created_by_user_id: budget.created_by_user_id,
  };
}

export function budgetFromSnapshot(snapshot: DocumentSnapshot): BudgetRecord {
  const value = data(snapshot);
  return {
    budget_id: snapshot.id,
    name: value.name,
    created_at: toDate(value.created_at),
    created_by_user_id: value.created_by_user_id ?? null,
  };
}

export function membershipToData(
  membership: Omit<MembershipRecord, 'membership_id'>,
): DocumentData {
  return {
    budget_id: membership.budget_id,
    user_id: membership.user_id,
    role: membership.role,
    status: membership.status,
    joined_at: toTimestamp(membership.joined_at),
    ended_at: membership.ended_at ? toTimestamp(membership.ended_at) : null,
  };
}

export function membershipFromSnapshot(
  snapshot: DocumentSnapshot,
): MembershipRecord {
  const value = data(snapshot);
  return {
    membership_id: snapshot.id,
    budget_id: value.budget_id,
    user_id: value.user_id ?? null,
    role: value.role,
    status: value.status,
    joined_at: toDate(value.joined_at),
    ended_at: toDateOrNull(value.ended_at),
  };
}

export interface ActiveMemberDoc {
  membership_id: string;
  role: MembershipRole;
  joined_at: Date;
  display_name: string | null;
  email: string | null;
}

export function activeMemberToData(member: ActiveMemberDoc): DocumentData {
  return {
    membership_id: member.membership_id,
    role: member.role,
    joined_at: toTimestamp(member.joined_at),
    display_name: member.display_name,
    email: member.email,
  };
}

export function activeMemberFromSnapshot(
  snapshot: DocumentSnapshot,
): ActiveMemberDoc & { user_id: string } {
  const value = data(snapshot);
  return {
    user_id: snapshot.id,
    membership_id: value.membership_id,
    role: value.role,
    joined_at: toDate(value.joined_at),
    display_name: value.display_name ?? null,
    email: value.email ?? null,
  };
}

export function invitationToData(
  invitation: Omit<InvitationRecord, 'invitation_id'>,
): DocumentData {
  return {
    budget_id: invitation.budget_id,
    invited_by_membership_id: invitation.invited_by_membership_id,
    invitee_email: invitation.invitee_email,
    token_hash: invitation.token_hash,
    status: invitation.status,
    created_at: toTimestamp(invitation.created_at),
    expires_at: toTimestamp(invitation.expires_at),
  };
}

export function invitationFromSnapshot(
  snapshot: DocumentSnapshot,
): InvitationRecord {
  const value = data(snapshot);
  return {
    invitation_id: snapshot.id,
    budget_id: value.budget_id,
    invited_by_membership_id: value.invited_by_membership_id,
    invitee_email: value.invitee_email ?? null,
    token_hash: value.token_hash,
    status: value.status,
    created_at: toDate(value.created_at),
    expires_at: toDate(value.expires_at),
  };
}

export function accountToData(
  account: Omit<AccountRecord, 'account_id'>,
): DocumentData {
  return {
    budget_id: account.budget_id,
    owner_membership_id: account.owner_membership_id,
    label: account.label,
    institution_name: account.institution_name,
    currency: account.currency,
    account_type: account.account_type,
    created_at: toTimestamp(account.created_at),
    archived_at: account.archived_at ? toTimestamp(account.archived_at) : null,
  };
}

export function accountFromSnapshot(snapshot: DocumentSnapshot): AccountRecord {
  const value = data(snapshot);
  return {
    account_id: snapshot.id,
    budget_id: value.budget_id,
    owner_membership_id: value.owner_membership_id,
    label: value.label,
    institution_name: value.institution_name ?? null,
    currency: value.currency,
    account_type: value.account_type,
    created_at: toDate(value.created_at),
    archived_at: toDateOrNull(value.archived_at),
  };
}
