import { createHash } from 'node:crypto';
import { Timestamp, type DocumentSnapshot } from 'firebase-admin/firestore';
import type {
  SaveTransactionRequest,
  SaveTransactionResult,
  SaveTransactionSplitRequest,
  SetTransactionHiddenRequest,
} from '../shared/contracts';
import { findMatchingUserRule } from '../shared/domain/transactions';
import { isTransactionHidden } from '../shared/domain/transactionFeatures';
import { DomainError } from '../shared/domain/errors';
import {
  budgetCollectionPath,
  budgetDocumentPath,
  COLLECTIONS,
} from '../shared/firestorePaths';
import {
  validateSaveTransactionRequest,
  validateSaveTransactionSplitRequest,
  validateDeleteTransactionSplitRequest,
  validateSetTransactionHiddenRequest,
} from '../shared/validators';
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
  if (request.type === 'TRANSFER') {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Confirm a transfer from the transfer review screen.',
    );
  }
  const transactionId = request.transaction_id ?? deps.newId();
  const ruleId = request.create_rule ? deps.newId() : null;

  await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');
    const transactionRef = deps.db.doc(
      budgetDocumentPath(
        request.budget_id,
        actor.active_revision_id,
        COLLECTIONS.transactions,
        transactionId,
      ),
    );
    const ruleRef = ruleId
      ? deps.db.doc(
          budgetDocumentPath(
            request.budget_id,
            actor.active_revision_id,
            COLLECTIONS.categorizationRules,
            ruleId,
          ),
        )
      : null;
    const accountRef = deps.db.doc(
      budgetDocumentPath(
        request.budget_id,
        actor.active_revision_id,
        COLLECTIONS.accounts,
        request.account_id,
      ),
    );

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
    if (existing.exists && existing.get('transfer_group_id') != null) {
      throw new DomainError(
        'INVALID_TRANSITION',
        'Confirmed transfer legs cannot be edited as ordinary transactions.',
      );
    }
    const existingSplitItems = existing.exists
      ? await tx.get(
          deps.db
            .collection(
              budgetCollectionPath(
                request.budget_id,
                actor.active_revision_id,
                COLLECTIONS.splitItems,
              ),
            )
            .where('budget_id', '==', request.budget_id)
            .where('transaction_id', '==', transactionId),
        )
      : null;
    if (
      existingSplitItems?.size &&
      (existing.get('amount') !== request.amount ||
        existing.get('currency') !== request.currency)
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Remove or update the split before changing the source amount or currency.',
      );
    }
    if (
      existing.exists &&
      isTransactionHidden(
        existing.get('hidden_mode'),
        timestampIso(existing.get('hidden_until')),
        deps.now(),
      ) &&
      existing.get('hidden_by_membership_id') !== actor.membership_id
    ) {
      throw new DomainError(
        'PERMISSION_DENIED',
        'Only the member who hid this transaction can edit it while it is hidden.',
      );
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
          .collection(
            budgetCollectionPath(
              request.budget_id,
              actor.active_revision_id,
              COLLECTIONS.categories,
            ),
          )
          .where('budget_id', '==', request.budget_id),
      ),
      tx.get(
        deps.db
          .collection(
            budgetCollectionPath(
              request.budget_id,
              actor.active_revision_id,
              COLLECTIONS.categorizationRules,
            ),
          )
          .where('budget_id', '==', request.budget_id)
          .where('source', '==', 'USER')
          .where('enabled', '==', true),
      ),
      existing.exists
        ? tx.get(
            deps.db
              .collection(
                budgetCollectionPath(
                  request.budget_id,
                  actor.active_revision_id,
                  COLLECTIONS.transactionTags,
                ),
              )
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
      deps.db.doc(
        budgetDocumentPath(
          request.budget_id,
          actor.active_revision_id,
          COLLECTIONS.tags,
          id,
        ),
      ),
    );
    const desiredTagSnapshots = await Promise.all(
      desiredTagRefs.map((ref) => tx.get(ref)),
    );
    const existingLinks = existingTagLinks?.docs ?? [];
    const linkedTagSnapshots = await Promise.all(
      existingLinks.map((link) =>
        tx.get(
          deps.db.doc(
            budgetDocumentPath(
              request.budget_id,
              actor.active_revision_id,
              COLLECTIONS.tags,
              link.get('tag_id') as string,
            ),
          ),
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
      expense_frequency:
        request.expense_frequency === undefined
          ? (existing.get('expense_frequency') ?? null)
          : request.expense_frequency,
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
            budgetDocumentPath(
              request.budget_id,
              actor.active_revision_id,
              COLLECTIONS.transactionTags,
              transactionTagId(transactionId, tag.id),
            ),
          ),
          { transaction_id: transactionId, tag_id: tag.id },
        );
      }
    }
  });
  return { transaction_id: transactionId };
}

export async function saveTransactionSplit(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<void> {
  const { uid } = requireCaller(caller);
  const request: SaveTransactionSplitRequest | null =
    validateSaveTransactionSplitRequest(input);
  if (!request) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid transaction split.');
  }
  await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');
    const transactionRef = deps.db.doc(
      budgetDocumentPath(
        request.budget_id,
        actor.active_revision_id,
        COLLECTIONS.transactions,
        request.transaction_id,
      ),
    );
    const splitQuery = deps.db
      .collection(
        budgetCollectionPath(
          request.budget_id,
          actor.active_revision_id,
          COLLECTIONS.splitItems,
        ),
      )
      .where('budget_id', '==', request.budget_id)
      .where('transaction_id', '==', request.transaction_id);
    const transaction = await tx.get(transactionRef);
    if (
      !transaction.exists ||
      transaction.get('budget_id') !== request.budget_id
    ) {
      throw new DomainError('NOT_FOUND');
    }
    assertHiddenTransactionAuthor(transaction, actor.membership_id, deps.now());
    if (transaction.get('transfer_group_id') != null) {
      throw new DomainError(
        'INVALID_TRANSITION',
        'Confirmed transfer legs cannot be split.',
      );
    }
    const existingItems = await tx.get(splitQuery);
    const categories = await tx.get(
      deps.db
        .collection(
          budgetCollectionPath(
            request.budget_id,
            actor.active_revision_id,
            COLLECTIONS.categories,
          ),
        )
        .where('budget_id', '==', request.budget_id),
    );
    const categoryById = new Map(
      categories.docs.map((category) => [category.id, category]),
    );
    const previouslyUsedCategoryIds = new Set(
      existingItems.docs.map((item) => item.get('category_id') as string),
    );
    for (const item of request.items) {
      const category = categoryById.get(item.category_id);
      if (
        !category ||
        category.get('kind') !== transaction.get('type') ||
        (category.get('archived_at') != null &&
          !previouslyUsedCategoryIds.has(item.category_id))
      ) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'Each split category must belong to this budget and match the transaction type.',
        );
      }
    }
    const sourceAmount = transaction.get('amount') as string;
    const amountTotal = request.items.reduce(
      (total, item) => total + decimalUnits(item.amount),
      0n,
    );
    if (decimalUnits(sourceAmount) !== amountTotal) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Split amounts must equal the source transaction amount.',
      );
    }
    for (const item of existingItems.docs) tx.delete(item.ref);
    request.items.forEach((item, position) => {
      const splitItemId = deps.newId();
      tx.create(
        deps.db.doc(
          budgetDocumentPath(
            request.budget_id,
            actor.active_revision_id,
            COLLECTIONS.splitItems,
            splitItemId,
          ),
        ),
        {
          split_item_id: splitItemId,
          budget_id: request.budget_id,
          transaction_id: request.transaction_id,
          category_id: item.category_id,
          amount: item.amount,
          expense_frequency: item.expense_frequency,
          description: item.description,
          note: item.note,
          position,
        },
      );
    });
  });
}

export async function deleteTransactionSplit(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<void> {
  const { uid } = requireCaller(caller);
  const request = validateDeleteTransactionSplitRequest(input);
  if (!request) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid transaction split.');
  }
  await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');
    const transaction = await tx.get(
      deps.db.doc(
        budgetDocumentPath(
          request.budget_id,
          actor.active_revision_id,
          COLLECTIONS.transactions,
          request.transaction_id,
        ),
      ),
    );
    if (
      !transaction.exists ||
      transaction.get('budget_id') !== request.budget_id
    ) {
      throw new DomainError('NOT_FOUND');
    }
    assertHiddenTransactionAuthor(transaction, actor.membership_id, deps.now());
    const items = await tx.get(
      deps.db
        .collection(
          budgetCollectionPath(
            request.budget_id,
            actor.active_revision_id,
            COLLECTIONS.splitItems,
          ),
        )
        .where('budget_id', '==', request.budget_id)
        .where('transaction_id', '==', request.transaction_id),
    );
    for (const item of items.docs) tx.delete(item.ref);
  });
}

export async function setTransactionHidden(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<void> {
  const { uid } = requireCaller(caller);
  const request: SetTransactionHiddenRequest | null =
    validateSetTransactionHiddenRequest(input);
  if (!request) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Invalid hidden transaction settings.',
    );
  }
  const hiddenUntil = request.hidden_until
    ? new Date(request.hidden_until)
    : null;
  if (hiddenUntil && hiddenUntil.getTime() <= deps.now().getTime()) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'The hidden period must end in the future.',
    );
  }
  await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');
    const transactionRef = deps.db.doc(
      budgetDocumentPath(
        request.budget_id,
        actor.active_revision_id,
        COLLECTIONS.transactions,
        request.transaction_id,
      ),
    );
    const transaction = await tx.get(transactionRef);
    if (
      !transaction.exists ||
      transaction.get('budget_id') !== request.budget_id
    ) {
      throw new DomainError('NOT_FOUND');
    }
    const currentUntil = timestampIso(transaction.get('hidden_until'));
    const currentlyHidden = isTransactionHidden(
      transaction.get('hidden_mode'),
      currentUntil,
      deps.now(),
    );
    if (currentlyHidden) {
      assertHiddenTransactionAuthor(
        transaction,
        actor.membership_id,
        deps.now(),
      );
      if (transaction.get('hidden_mode') !== request.hidden_mode) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'The hidden mode cannot be changed before the current hiding expires.',
        );
      }
    }
    tx.update(transactionRef, {
      hidden_mode: request.hidden_mode,
      hidden_until: hiddenUntil ? toTimestamp(hiddenUntil) : null,
      hidden_by_membership_id: actor.membership_id,
    });
  });
}

function decimalUnits(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const units = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  return negative ? -units : units;
}

function timestampIso(value: unknown): string | null {
  return value instanceof Timestamp ? value.toDate().toISOString() : null;
}

function assertHiddenTransactionAuthor(
  transaction: DocumentSnapshot,
  membershipId: string,
  now: Date,
): void {
  if (
    isTransactionHidden(
      transaction.get('hidden_mode'),
      timestampIso(transaction.get('hidden_until')),
      now,
    ) &&
    transaction.get('hidden_by_membership_id') !== membershipId
  ) {
    throw new DomainError(
      'PERMISSION_DENIED',
      'Only the member who hid this transaction can edit it while it is hidden.',
    );
  }
}
