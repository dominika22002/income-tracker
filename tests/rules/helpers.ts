import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, Timestamp } from 'firebase/firestore';

export interface SeedMember {
  userId: string;
  membershipId: string;
  role?: 'ADMIN' | 'MEMBER';
  joinedAt?: Date;
}

const DEFAULT_JOINED = new Date('2026-01-01T00:00:00Z');

/** Seeds an active budget with its memberships and access index documents. */
export async function seedBudget(
  testEnv: RulesTestEnvironment,
  budgetId: string,
  name: string,
  members: SeedMember[],
): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, `budgets/${budgetId}`), {
      name,
      created_at: Timestamp.fromDate(DEFAULT_JOINED),
      created_by_user_id: members[0]?.userId ?? null,
    });
    for (const member of members) {
      const role = member.role ?? 'MEMBER';
      const joinedAt = Timestamp.fromDate(member.joinedAt ?? DEFAULT_JOINED);
      await setDoc(doc(db, `memberships/${member.membershipId}`), {
        budget_id: budgetId,
        user_id: member.userId,
        role,
        status: 'ACTIVE',
        joined_at: joinedAt,
        ended_at: null,
      });
      await setDoc(
        doc(db, `budgets/${budgetId}/active_members/${member.userId}`),
        {
          membership_id: member.membershipId,
          role,
          joined_at: joinedAt,
          display_name: member.userId,
          email: `${member.userId}@example.test`,
        },
      );
    }
  });
}

export async function seedEndedMembership(
  testEnv: RulesTestEnvironment,
  membershipId: string,
  budgetId: string,
  userId: string | null,
  status: 'LEFT' | 'REMOVED',
): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `memberships/${membershipId}`), {
      budget_id: budgetId,
      user_id: userId,
      role: 'MEMBER',
      status,
      joined_at: Timestamp.fromDate(DEFAULT_JOINED),
      ended_at: Timestamp.fromDate(new Date('2026-02-01T00:00:00Z')),
    });
  });
}
