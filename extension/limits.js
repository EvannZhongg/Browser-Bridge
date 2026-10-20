// Navigation can use its full wait budget plus a bounded observation phase.
// Leave transport headroom so this never releases an otherwise healthy claim.
export const NAVIGATION_MAX_TIMEOUT_MS = 40000;
export const NAVIGATION_OBSERVATION_TIMEOUT_MS = 10000;
export const HUB_OPERATION_TIMEOUT_MS = 60000;
export const CLIENT_RESPONSE_TIMEOUT_MS = 65000;
