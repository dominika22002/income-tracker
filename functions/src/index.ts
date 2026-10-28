import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  createHandlers,
  toCallableError,
  type CallableName,
} from '../../src/server/callable';
import { createServerDeps } from '../../src/server/context';

initializeApp();

const handlers = createHandlers({
  ...createServerDeps(getFirestore()),
  deleteAuthUser: (uid) => getAuth().deleteUser(uid),
});

// Authentication comes from the verified Firebase ID token only.
function callable(name: CallableName) {
  return onCall(async (request) => {
    try {
      return (await handlers[name](request.auth, request.data)) ?? null;
    } catch (error) {
      const mapped = toCallableError(error);
      if (mapped.code === 'internal') {
        logger.error(`${name} failed`, error);
      }
      throw new HttpsError(mapped.code, mapped.message, {
        code: mapped.domainCode ?? null,
      });
    }
  });
}

export const ensureUserProfile = callable('ensureUserProfile');
export const updatePreferences = callable('updatePreferences');
export const createBudget = callable('createBudget');
export const createAccount = callable('createAccount');
export const commitCsvImport = callable('commitCsvImport');
export const createInvitation = callable('createInvitation');
export const previewInvitation = callable('previewInvitation');
export const acceptInvitation = callable('acceptInvitation');
export const declineInvitation = callable('declineInvitation');
export const cancelInvitation = callable('cancelInvitation');
export const leaveBudget = callable('leaveBudget');
export const removeMember = callable('removeMember');
export const deleteMyProfile = callable('deleteMyProfile');
