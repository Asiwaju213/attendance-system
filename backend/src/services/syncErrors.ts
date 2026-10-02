/**
 * The error type shared by the sync apply layer.
 *
 * It lives in its own module because both `syncApplyService` (which raises it
 * while driving a batch) and `syncMasterDataAppliers` (which raises it while
 * writing one entity) need it. Importing it from either of those would make the
 * two modules import each other, and a cycle between modules that both use the
 * class at call time is exactly the kind of thing that breaks differently
 * depending on which one is loaded first.
 */
export class SyncApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncApplyError";
  }
}

/**
 * A structured failure the transport can distinguish from a generic bug.
 *
 * `retryable` is the only thing the worker really needs: a network failure or a
 * 5xx should be retried with backoff, while a 401 means the credential is wrong
 * and retrying it forever would just hide a configuration mistake in noise.
 */
export class SyncFeedError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "SyncFeedError";
    this.retryable = retryable;
  }
}

/**
 * A batch that is internally inconsistent and therefore must not be applied at
 * all.
 *
 * Raised instead of applying "as much as looks safe", because a partial apply
 * would move the cursor past events that were never applied, which is the one
 * failure the cursor model exists to make impossible.
 */
export class SyncFeedGapError extends SyncApplyError {
  constructor(message: string) {
    super(message);
    this.name = "SyncFeedGapError";
  }
}