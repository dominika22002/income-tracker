import { createHash } from 'node:crypto';
import type {
  SaveTransactionRequest,
  SaveTransactionResult,
} from '../shared/contracts';
import { findMatchingUserRule } from '../shared/domain/transactions';
import { DomainError } from '../shared/domain/errors';
import { COLLECTIONS } from '../shared/firestorePaths';
import { validateSaveTransactionRequest } from '../shared/validators';
import { readActiveMembership } from './access';
import { membershipFromSnapshot, toTimestamp } from './converters';
import { requireCaller, type Caller, type ServerDeps } from './context';

function normalizedTagName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function stableTagId(budgetId: string, name: string): string {
  const hex = createHash('sha256')
    .update(`${budgetId}\0${normalizedTagName(name)}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function transactionTagId(transactionId: string, tagId: string): string {
  return createHash('sha256')
    .update(`${transactionId}\0${tagId}`)
    .digest('hex');
}

export async function saveTransaction(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<SaveTransactionResult> {
  const { uid } = requireCaller(caller);
  const request: SaveTransactionRequest | null =
    validateSaveTransactionRequest(input);
  if (!request) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid transaction request.');
  }
  const transactionId = request.transaction_id ?? deps.newId();
  const transactionRef = deps.db.doc(
    `${COLLECTIONS.transactions}/${transactionId}`,
  );
  const ruleId = request.create_rule ? deps.newId() : null;
  const ruleRef = ruleId
    ? deps.db.doc(`${COLLECTIONS.categorizationRules}/${ruleId}`)
    : null;
  const accountRef = deps.db.doc(
    `${COLLECTIONS.accounts}/${request.account_id}`,
  );

  await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');

    const [account, existing] = await Promise.all([
      tx.get(accountRef),
      tx.get(transactionRef),
    ]);
    if (!account.exists || account.get('budget_id') !== request.budget_id) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Account is outside this budget.',
      );
    }
    if (account.get('archived_at') != null) {
      throw new DomainError('INVALID_ARGUMENT', 'Account is archived.');
    }
    if (existing.exists && existing.get('budget_id') !== request.budget_id) {
      throw new DomainError('NOT_FOUND');
    }
    if (
      existing.exists &&
      existing.get('import_batch_id') != null &&
      existing.get('account_id') !== request.account_id
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'The source account of an imported transaction cannot be changed.',
      );
    }

    const owner = await tx.get(
      deps.db.doc(
        `${COLLECTIONS.memberships}/${account.get('owner_membership_id') as string}`,
      ),
    );
    if (
      !owner.exists ||
      membershipFromSnapshot(owner).budget_id !== request.budget_id
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'The account owner must belong to this budget.',
      );
    }

    const [categories, rules, existingTagLinks] = await Promise.all([
      tx.get(
        deps.db
          .collection(COLLECTIONS.categories)
          .where('budget_id', '==', request.budget_id),
      ),
      tx.get(
        deps.db
          .collection(COLLECTIONS.categorizationRules)
          .where('budget_id', '==', request.budget_id)
          .where('source', '==', 'USER')
          .where('enabled', '==', true),
      ),
      existing.exists
        ? tx.get(
            deps.db
              .collection(COLLECTIONS.transactionTags)
              .where('transaction_id', '==', transactionId),
          )
        : Promise.resolve(null),
    ]);

    const categoryById = new Map(
      categories.docs.map((category) => [category.id, category]),
    );
    const priorCategoryId = existing.get('category_id') as string | null;
    let categoryId =
      request.category_id === undefined
        ? (priorCategoryId ?? null)
        : request.category_id;

    if (categoryId) {
      const selectedCategory = categoryById.get(categoryId);
      if (
        !selectedCategory ||
        selectedCategory.get('kind') !== request.type ||
        (selectedCategory.get('archived_at') != null &&
          categoryId !== priorCategoryId)
      ) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'Category must belong to this budget and match the transaction type.',
        );
      }
    } else if (request.category_id === undefined) {
      const match = findMatchingUserRule(
        {
          description: request.description,
          amount: request.amount,
          account_id: request.account_id,
        },
        rules.docs.map((rule) => ({
          rule_id: rule.id,
          category_id: rule.get('category_id') as string,
          match_field: rule.get('match_field'),
          operator: rule.get('operator'),
          match_value: rule.get('match_value') as string,
          priority: rule.get('priority') as number,
          enabled: rule.get('enabled') === true,
        })),
      );
      const matchedCategory = match
        ? categoryById.get(match.category_id)
        : undefined;
      if (
        matchedCategory &&
        matchedCategory.get('kind') === request.type &&
        matchedCategory.get('archived_at') == null
      ) {
        categoryId = matchedCategory.id;
      }
    }
    if (request.create_rule) {
      if (!ruleRef || !categoryId) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'A category is required to create a categorization rule.',
        );
      }
      const ruleCategory = categoryById.get(categoryId);
      if (
        !ruleCategory ||
        ruleCategory.get('kind') !== request.type ||
        ruleCategory.get('archived_at') != null
      ) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'The rule category must be active and match the transaction type.',
        );
      }
    }

    const tagsWereProvided = request.tags !== undefined;
    const desiredTags = (request.tags ?? []).map((name) => ({
      name: name.normalize('NFKC').trim().replace(/\s+/g, ' '),
      id: stableTagId(request.budget_id, name),
    }));
    const desiredTagRefs = desiredTags.map(({ id }) =>
      deps.db.doc(`${COLLECTIONS.tags}/${id}`),
    );
    const desiredTagSnapshots = await Promise.all(
      desiredTagRefs.map((ref) => tx.get(ref)),
    );
    const existingLinks = existingTagLinks?.docs ?? [];
    const linkedTagSnapshots = await Promise.all(
      existingLinks.map((link) =>
        tx.get(
          deps.db.doc(`${COLLECTIONS.tags}/${link.get('tag_id') as string}`),
        ),
      ),
    );
    if (
      linkedTagSnapshots.some(
        (tag) => !tag.exists || tag.get('budget_id') !== request.budget_id,
      )
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Transaction has an invalid tag association.',
      );
    }

    const now = deps.now();
    const transactionData = {
      budget_id: request.budget_id,
      account_id: request.account_id,
      import_batch_id: existing.get('import_batch_id') ?? null,
      source_row_number: existing.get('source_row_number') ?? null,
      bank_transaction_id: existing.get('bank_transaction_id') ?? null,
      normalized_fingerprint: existing.get('normalized_fingerprint') ?? null,
      operation_date: request.operation_date,
      description: request.description,
      amount: request.amount,
      currency: request.currency,
      type: request.type,
      category_id: categoryId,
      created_by_membership_id:
        existing.get('created_by_membership_id') ?? actor.membership_id,
      created_at: existing.exists
        ? existing.get('created_at')
        : toTimestamp(now),
      note:
        request.note === undefined
          ? (existing.get('note') ?? null)
          : request.note,
    };
    if (existing.exists)
      tx.set(transactionRef, transactionData, { merge: true });
    else tx.create(transactionRef, transactionData);
    if (request.create_rule && ruleRef) {
      tx.create(ruleRef, {
        budget_id: request.budget_id,
        category_id: categoryId,
        created_by_membership_id: actor.membership_id,
        source: 'USER',
        match_field: request.create_rule.match_field,
        operator: request.create_rule.operator,
        match_value: request.create_rule.match_value,
        priority: request.create_rule.priority,
        enabled: true,
      });
    }

    const currentTagIds = new Set(
      existingLinks.map((link) => link.get('tag_id') as string),
    );
    const desiredTagIds = new Set(desiredTags.map(({ id }) => id));
    for (const link of existingLinks) {
      if (
        tagsWereProvided &&
        !desiredTagIds.has(link.get('tag_id') as string)
      ) {
        tx.delete(link.ref);
      }
    }
    for (let index = 0; index < desiredTags.length; index += 1) {
      const tag = desiredTags[index];
      const tagRef = desiredTagRefs[index];
      const snapshot = desiredTagSnapshots[index];
      if (snapshot.exists) {
        if (snapshot.get('budget_id') !== request.budget_id) {
          throw new DomainError(
            'INVALID_ARGUMENT',
            'Tag is outside this budget.',
          );
        }
      } else {
        tx.create(tagRef, {
          budget_id: request.budget_id,
          name: tag.name,
          created_by_membership_id: actor.membership_id,
        });
      }
      if (!currentTagIds.has(tag.id)) {
        tx.create(
          deps.db.doc(
            `${COLLECTIONS.transactionTags}/${transactionTagId(transactionId, tag.id)}`,
          ),
          { transaction_id: transactionId, tag_id: tag.id },
        );
      }
    }
  });
  return { transaction_id: transactionId };
}
