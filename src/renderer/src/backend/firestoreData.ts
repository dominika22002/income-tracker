import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where,
  type Firestore,
  type Timestamp,
} from 'firebase/firestore';
import type {
  InvitationView,
  MemberView,
  MyBudgetView,
  UserPreferencesRecord,
} from '../../../shared/contracts';
import { compareMembersForSuccession } from '../../../shared/domain/membership';
import type { BudgetDataSource } from './ports';

function iso(value: unknown): string {
  return (value as Timestamp).toDate().toISOString();
}

export function createFirestoreDataSource(db: Firestore): BudgetDataSource {
  return {
    subscribeMyBudgets(uid, onData, onError) {
      let active = true;
      const unsubscribe = onSnapshot(
        query(
          collection(db, 'memberships'),
          where('user_id', '==', uid),
          where('status', '==', 'ACTIVE'),
        ),
        (snapshot) => {
          void Promise.all(
            snapshot.docs.map(
              async (membership): Promise<MyBudgetView | null> => {
                try {
                  const budget = await getDoc(
                    doc(db, 'budgets', membership.get('budget_id') as string),
                  );
                  if (!budget.exists()) return null;
                  return {
                    budget_id: budget.id,
                    name: budget.get('name') as string,
                    membership_id: membership.id,
                    role: membership.get('role') as MyBudgetView['role'],
                  };
                } catch {
                  // Access was revoked between the two reads.
                  return null;
                }
              },
            ),
          ).then((budgets) => {
            if (!active) return;
            onData(
              budgets
                .filter((budget): budget is MyBudgetView => budget !== null)
                .sort((a, b) => a.name.localeCompare(b.name)),
            );
          });
        },
        onError,
      );
      return () => {
        active = false;
        unsubscribe();
      };
    },

    subscribeMembers(budgetId, onData, onError) {
      return onSnapshot(
        collection(db, 'budgets', budgetId, 'active_members'),
        (snapshot) => {
          const members = snapshot.docs.map((member) => ({
            user_id: member.id,
            membership_id: member.get('membership_id') as string,
            role: member.get('role') as MemberView['role'],
            joined_at: iso(member.get('joined_at')),
            display_name: (member.get('display_name') as string | null) ?? null,
            email: (member.get('email') as string | null) ?? null,
          }));
          members.sort((a, b) =>
            compareMembersForSuccession(
              { ...a, joined_at: new Date(a.joined_at) },
              { ...b, joined_at: new Date(b.joined_at) },
            ),
          );
          onData(members);
        },
        onError,
      );
    },

    subscribeInvitations(budgetId, onData, onError) {
      return onSnapshot(
        query(
          collection(db, 'invitations'),
          where('budget_id', '==', budgetId),
        ),
        (snapshot) => {
          const invitations: InvitationView[] = snapshot.docs
            .map((invitation) => ({
              invitation_id: invitation.id,
              status: invitation.get('status') as InvitationView['status'],
              invitee_email:
                (invitation.get('invitee_email') as string | null) ?? null,
              created_at: iso(invitation.get('created_at')),
              expires_at: iso(invitation.get('expires_at')),
            }))
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
          onData(invitations);
        },
        onError,
      );
    },

    async getPreferences(uid): Promise<UserPreferencesRecord | null> {
      const snapshot = await getDoc(doc(db, 'user_preferences', uid));
      if (!snapshot.exists()) return null;
      return {
        user_id: uid,
        primary_currency: snapshot.get('primary_currency') as string,
        secondary_currencies: snapshot.get('secondary_currencies') as string[],
      };
    },
  };
}
