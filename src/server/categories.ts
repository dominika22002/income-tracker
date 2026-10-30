import type {
  ArchiveCategoryRequest,
  SaveCategoryResult,
} from '../shared/contracts';
import {
  budgetCollectionPath,
  budgetDocumentPath,
  COLLECTIONS,
} from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import {
  validateArchiveCategoryRequest,
  validateSaveCategoryRequest,
} from '../shared/validators';
import { readActiveMembership } from './access';
import { toTimestamp } from './converters';
import { requireCaller, type Caller, type ServerDeps } from './context';

export async function saveCategory(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<SaveCategoryResult> {
  const { uid } = requireCaller(caller);
  const request = validateSaveCategoryRequest(input);
  if (!request) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid category request.');
  }
  const categoryId = request.category_id ?? deps.newId();
  const parentId = request.category_id
    ? undefined
    : (request.parent_category_id ?? null);

  return deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');
    const categoryRef = deps.db.doc(
      budgetDocumentPath(
        request.budget_id,
        actor.active_revision_id,
        COLLECTIONS.categories,
        categoryId,
      ),
    );

    const [existing, categories] = await Promise.all([
      tx.get(categoryRef),
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
    ]);
    if (request.category_id && !existing.exists) {
      throw new DomainError('NOT_FOUND');
    }

    const existingData = existing.data();
    if (
      existingData &&
      (existingData.budget_id !== request.budget_id ||
        existingData.archived_at != null)
    ) {
      throw new DomainError('NOT_FOUND');
    }
    if (existingData && existingData.kind !== request.kind) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'A category kind cannot be changed after creation.',
      );
    }

    const effectiveParentId =
      parentId ?? (existingData?.parent_category_id as string | null) ?? null;
    if (effectiveParentId === categoryId) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'A category cannot parent itself.',
      );
    }
    if (effectiveParentId) {
      const parent = categories.docs.find(
        (category) => category.id === effectiveParentId,
      );
      if (
        !parent ||
        parent.get('archived_at') != null ||
        parent.get('kind') !== request.kind
      ) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'The parent category must be active and have the same kind.',
        );
      }
    }

    const duplicate = categories.docs.some((category) => {
      if (category.id === categoryId) return false;
      return (
        (category.get('parent_category_id') ?? null) === effectiveParentId &&
        category.get('archived_at') == null &&
        String(category.get('name')).trim().toLocaleLowerCase() ===
          request.name.toLocaleLowerCase()
      );
    });
    if (duplicate) {
      throw new DomainError(
        'ALREADY_EXISTS',
        'A category with this name already exists here.',
      );
    }

    if (existingData) {
      tx.update(categoryRef, {
        name: request.name,
        sort_order: request.sort_order,
        ...(request.expense_nature === undefined
          ? {}
          : { expense_nature: request.expense_nature }),
      });
    } else {
      tx.create(categoryRef, {
        budget_id: request.budget_id,
        parent_category_id: effectiveParentId,
        name: request.name,
        kind: request.kind,
        expense_nature: request.expense_nature ?? null,
        sort_order: request.sort_order,
        created_by_membership_id: actor.membership_id,
        archived_at: null,
      });
    }
    return { category_id: categoryId };
  });
}

export async function archiveCategory(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<void> {
  const { uid } = requireCaller(caller);
  const request: ArchiveCategoryRequest | null =
    validateArchiveCategoryRequest(input);
  if (!request) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid category request.');
  }
  await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');
    const categoryRef = deps.db.doc(
      budgetDocumentPath(
        request.budget_id,
        actor.active_revision_id,
        COLLECTIONS.categories,
        request.category_id,
      ),
    );
    const rulesQuery = deps.db
      .collection(
        budgetCollectionPath(
          request.budget_id,
          actor.active_revision_id,
          COLLECTIONS.categorizationRules,
        ),
      )
      .where('budget_id', '==', request.budget_id)
      .where('category_id', '==', request.category_id);
    const [category, rules] = await Promise.all([
      tx.get(categoryRef),
      tx.get(rulesQuery),
    ]);
    if (!category.exists || category.get('budget_id') !== request.budget_id) {
      throw new DomainError('NOT_FOUND');
    }
    if (category.get('archived_at') != null) return;

    const archivedAt = deps.now();
    tx.update(categoryRef, {
      archived_at: toTimestamp(archivedAt),
    });
    for (const rule of rules.docs) {
      if (rule.get('enabled') === true) {
        tx.update(rule.ref, { enabled: false });
      }
    }
  });
}
