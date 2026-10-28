// packages/auth/src/index.ts
// Do NOT import context.server from this barrel — it has next/headers
// Import explicitly: import { getContext } from '@synapse/auth/context'

export { signToken, verifyToken, signShortToken, verifyShortToken } from './tokens'
export type { SynapseTokenPayload } from './tokens'

export {
  ACCOUNT_ACTIVATION_ERROR,
  ACCOUNT_UNAVAILABLE_ERROR,
  ACCOUNT_LOCKED_ERROR,
  accountStateResponse,
  classifyAccountState,
  isAccountActivated,
} from './activation'
export type { AccountState, AccountStateCode, AccountStateProfile, AccountStateResponse } from './activation'

export { hashPassword, verifyPassword, validatePasswordStrength } from './password'

export {
  createAndSendOTP,
  verifyOTP,
  generateOTP,
  hashOTP,
  verifyOTPHash,
  otpCreatePolicy,
} from './otp'

export {
  E2E_FACILITY_SLUGS,
  E2E_ROLE_EMAILS,
  resolveE2eOtp,
  shouldSkipOtpEmailDelivery,
  isE2eAllowlistedEmail,
  isE2eFacilitySlug,
  assertE2eSeedAllowed,
} from './e2e-otp'
export type { E2eOtpContext } from './e2e-otp'

export {
  createSession, validateSession, revokeSession, revokeAllUserSessions, hashToken,
} from './sessions'

export { requireCapability, checkCapability, CapabilityError } from './capability'

export { generateTotpSecret, totpUri, verifyTotp, currentTotpTimeStep, matchingTotpTimeStep } from './totp'

export {
  MFA_PENDING_COOKIE,
  PHARM_MFA_SATISFIED_COOKIE,
  signMfaPendingToken,
  verifyMfaPendingToken,
  signPharmMfaSatisfiedToken,
  verifyPharmMfaSatisfiedToken,
  mfaCookieOptions,
  pharmMfaCookieOptions,
} from './mfa'

export {
  DESTRUCTIVE_ACTION_MFA_MAX_AGE_MS,
  hasRecentVerifiedMfa,
  verifyStepUpMfa,
} from './mfa-recency'
export type { StepUpMfaResult } from './mfa-recency'

export { requireFeature, requireActiveSubscription, checkFeature, gateFeature, subscriptionRequiredResponse, FeatureGateError } from './features'
export {
  getSubscriptionStatus,
  listSubscriptionPayments,
  listAllPayments,
  listActivePharmacyPlans,
  listSubscriptionInvoices,
  getSubscriptionInvoice,
  initiateSubscriptionPayment,
  confirmSubscriptionPayment,
  handleFlutterwaveWebhook,
  isTenantEntitled,
  getEffectiveSubscription,
  billingCycleMonths,
  addBillingCycle,
  kampalaStamp,
  kampalaDateYMD,
  kampalaMidnightUtc,
  recordAndSendTrialReceipt,
} from './billing/subscription'
export type {
  SubscriptionStatus,
  PaymentRow,
  ActivePlanRow,
  InitSubscribeInput,
  InitSubscribeResult,
  ConfirmPaymentInput,
  ConfirmPaymentResult,
  BillingCycle,
  TrialReceiptInput,
  SubscriptionInvoiceRow,
} from './billing/subscription'
export {
  evaluateEntitlement,
  ENTITLED_STATUSES,
  BLOCKED_STATUSES,
  resolveEffectiveSubscription,
} from './billing/entitlement'
export type { EntitlementInput, EntitlementResult, ManualGrantInput, EffectiveSubscription } from './billing/entitlement'
export { verifyWebhookHash } from './billing/flutterwave'
export {
  PHARMACY_INVENTORY_MUTATOR_ROLES,
  canMutatePharmacyInventory,
} from './pharmacy-mobile-roles'
export {
  PHARMACY_CAPABILITIES,
  LEGACY_PERMISSION_TO_CAPABILITY,
  ROLE_CAPABILITIES,
  normalizePharmacyRole,
  isPharmacyCapability,
  resolveCapability,
  capabilitiesForRole,
  roleHasCapability,
  sessionHasCapability,
  sessionHasAnyCapability,
} from './pharmacy-capabilities'
export type {
  PharmacyCapability,
  PharmacyCapabilityRole,
  CapabilitySession,
} from './pharmacy-capabilities'

export {
  ACCOUNT_SUSPENSION_METADATA_KEY,
  ACCOUNT_SUSPENSION_MARKER_ROLE,
  AccountSuspendedError,
  isAccountSuspended,
  isAccountSuspensionMarker,
  suspendedUserIds,
  suspensionMetadataOf,
  withMembershipSuspension,
  type AccountSuspensionMetadata,
} from './account-suspension'

export {
  listProfileWorkspaces,
  mergeWorkspaces,
  pickWorkspace,
  workspaceTenantIds,
  type SynapseWorkspace,
  type WorkspacePharmacySettings,
  type WorkspaceProfile,
  type WorkspaceScope,
  type WorkspaceSources,
  type WorkspaceTenant,
} from './workspaces'

export { resolveSessionScope } from './session-scope'
