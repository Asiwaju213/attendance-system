import { AuthUser } from "./auth";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      /**
       * Row id of the session that authenticated this request, when one did.
       * Present only after `requireAuth`; used to keep the current session alive while
       * revoking every other session of the same account.
       */
      sessionId?: number;
    }
  }
}

export {};
