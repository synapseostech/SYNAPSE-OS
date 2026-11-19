/** Control-plane roles for admin.synapseos.tech governance portal. */
export const PLATFORM_ROLES = [
  "SUPER_ADMIN",
  "PLATFORM_ADMIN",
  "OPERATIONS_ADMIN",
  "RELEASE_MANAGER",
  "SECURITY_ADMIN",
  "FINANCE_ADMIN",
  "SUPPORT_ADMIN",
  "CLINICAL_GOVERNANCE",
  "STAKEHOLDER",
  "BOARD_OBSERVER",
  "INVESTOR_OBSERVER",
  "TECHNICAL_OBSERVER",
  "AUDITOR",
  "READ_ONLY_OBSERVER",
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export type PlatformMembershipStatus =
  | "INVITED"
  | "ACTIVE"
  | "SUSPENDED"
  | "REVOKED"
  | "EXPIRED";

/** Fine-grained control-plane capabilities. */
export const PLATFORM_CAPABILITIES = [
  "platform.dashboard.read",
  "product.read",
  "capability.read",
  "test_center.read",
  "simulation.read",
  "simulation.manage",
  "deployment.read",
  "release.read",
  "integration.read",
  "event.read",
  "incident.read",
  "analytics.read",
  "finance_summary.read",
  "security_summary.read",
  "audit.read",
  "user.read",
  "user.invite",
  "user.role.manage",
  "user.suspend",
  "user.reactivate",
  "user.session.revoke",
  "user.password_reset",
  "user.mfa.manage",
  "deployment.manage",
  "release.manage",
  "integration.manage",
  "feature_flag.manage",
  "incident.manage",
  "tenant.read",
  "tenant.manage",
  "tenant.impersonate",
  "tenant.purge",
  "system_health.read",
  "platform.subscription.read",
  "platform.subscription.manage",
  "platform.subscriptions.activate",
  "platform.subscriptions.override_price",
  "platform.pricing.read",
  "platform.pricing.manage",
  "platform.crm.read",
  "platform.crm.manage",
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

const ALL_READ: PlatformCapability[] = [
  "platform.dashboard.read",
  "product.read",
  "capability.read",
  "test_center.read",
  "simulation.read",
  "deployment.read",
  "release.read",
  "integration.read",
  "event.read",
  "incident.read",
  "analytics.read",
  "audit.read",
];

const OBSERVER_READ: PlatformCapability[] = [
  ...ALL_READ,
  "security_summary.read",
];

const ROLE_CAPABILITIES: Record<PlatformRole, PlatformCapability[]> = {
  SUPER_ADMIN: [...PLATFORM_CAPABILITIES],
  PLATFORM_ADMIN: [
    ...ALL_READ,
    "simulation.manage",
    "finance_summary.read",
    "security_summary.read",
    "user.read",
    "user.invite",
    "user.role.manage",
    "user.suspend",
    "user.reactivate",
    "user.session.revoke",
    "user.password_reset",
    "user.mfa.manage",
    "deployment.manage",
    "release.manage",
    "integration.manage",
    "feature_flag.manage",
    "incident.manage",
    "tenant.read",
    "tenant.manage",
    "tenant.impersonate",
    "system_health.read",
    "platform.subscription.read",
    "platform.subscription.manage",
    "platform.subscriptions.activate",
    "platform.subscriptions.override_price",
    "platform.pricing.read",
    "platform.pricing.manage",
    "platform.crm.read",
    "platform.crm.manage",
  ],
  // Day-to-day running of every product's tenants: onboarding, suspension,
  // support escalations and incidents. No pricing, roles or purges.
  OPERATIONS_ADMIN: [
    ...ALL_READ,
    "security_summary.read",
    "system_health.read",
    "user.read",
    "user.invite",
    "user.suspend",
    "user.reactivate",
    "user.session.revoke",
    "user.password_reset",
    "tenant.read",
    "tenant.manage",
    "tenant.impersonate",
    "incident.manage",
    "platform.subscription.read",
    "platform.pricing.read",
    "platform.crm.read",
  ],
  RELEASE_MANAGER: [
    ...ALL_READ,
    "system_health.read",
    "deployment.read",
    "release.read",
    "deployment.manage",
    "release.manage",
    "incident.read",
    "incident.manage",
  ],
  SECURITY_ADMIN: [
    ...ALL_READ,
    "security_summary.read",
    "audit.read",
    "system_health.read",
    "tenant.read",
    "user.read",
    "user.session.revoke",
    "user.mfa.manage",
    "incident.manage",
  ],
  FINANCE_ADMIN: [
    "platform.dashboard.read",
    "product.read",
    "analytics.read",
    "finance_summary.read",
    "audit.read",
    "tenant.read",
    "platform.pricing.read",
    "platform.pricing.manage",
    "platform.crm.read",
    "platform.subscription.read",
    "platform.subscriptions.activate",
    // Price override remains SUPER_ADMIN / PLATFORM_ADMIN only
  ],
  SUPPORT_ADMIN: [
    "platform.dashboard.read",
    "product.read",
    "test_center.read",
    "incident.read",
    "audit.read",
    "user.read",
    "user.password_reset",
    "tenant.read",
    "system_health.read",
    "platform.crm.read",
  ],
  CLINICAL_GOVERNANCE: [
    ...OBSERVER_READ,
    "test_center.read",
    "simulation.read",
    "simulation.manage",
  ],
  STAKEHOLDER: OBSERVER_READ,
  BOARD_OBSERVER: OBSERVER_READ,
  INVESTOR_OBSERVER: [
    "platform.dashboard.read",
    "product.read",
    "analytics.read",
    "finance_summary.read",
    "deployment.read",
    "release.read",
    "incident.read",
    "test_center.read",
  ],
  TECHNICAL_OBSERVER: [
    ...OBSERVER_READ,
    "simulation.read",
    "integration.read",
    "event.read",
    "system_health.read",
  ],
  // Read-only auditor: sees every tenant, the audit trail, finance and
  // security summaries and system health, and can change nothing.
  AUDITOR: [
    ...OBSERVER_READ,
    "finance_summary.read",
    "security_summary.read",
    "system_health.read",
    "tenant.read",
    "user.read",
    "platform.subscription.read",
    "platform.pricing.read",
  ],
  READ_ONLY_OBSERVER: OBSERVER_READ,
};

/** Roles that must enroll MFA before platform access. */
export const MFA_MANDATORY_ROLES: PlatformRole[] = [
  "SUPER_ADMIN",
  "PLATFORM_ADMIN",
  "OPERATIONS_ADMIN",
  "FINANCE_ADMIN",
  "SECURITY_ADMIN",
  "RELEASE_MANAGER",
];

export const OBSERVER_ROLES: PlatformRole[] = [
  "STAKEHOLDER",
  "BOARD_OBSERVER",
  "INVESTOR_OBSERVER",
  "TECHNICAL_OBSERVER",
  "AUDITOR",
  "READ_ONLY_OBSERVER",
];

export const ADMIN_ROLES: PlatformRole[] = [
  "SUPER_ADMIN",
  "PLATFORM_ADMIN",
  "OPERATIONS_ADMIN",
  "RELEASE_MANAGER",
  "SECURITY_ADMIN",
  "FINANCE_ADMIN",
  "SUPPORT_ADMIN",
  "CLINICAL_GOVERNANCE",
];

export function isPlatformRole(value: string): value is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(value);
}

export function roleCapabilities(role: PlatformRole): PlatformCapability[] {
  return ROLE_CAPABILITIES[role] ?? [];
}

export function roleHasCapability(role: PlatformRole, capability: PlatformCapability): boolean {
  return roleCapabilities(role).includes(capability);
}

/** Which roles an actor may assign or manage. */
export function manageableRoles(actorRole: PlatformRole): PlatformRole[] {
  if (actorRole === "SUPER_ADMIN") return [...PLATFORM_ROLES];
  if (actorRole === "PLATFORM_ADMIN") {
    return PLATFORM_ROLES.filter((r) => r !== "SUPER_ADMIN");
  }
  if (actorRole === "SECURITY_ADMIN") {
    return OBSERVER_ROLES;
  }
  return [];
}

export function canManageTargetRole(actorRole: PlatformRole, targetRole: PlatformRole): boolean {
  return manageableRoles(actorRole).includes(targetRole);
}

export function canResetPasswordFor(actorRole: PlatformRole, targetRole: PlatformRole): boolean {
  if (!roleHasCapability(actorRole, "user.password_reset")) return false;
  return canManageTargetRole(actorRole, targetRole);
}

export function isObserverRole(role: PlatformRole): boolean {
  return OBSERVER_ROLES.includes(role);
}

export function roleLabel(role: PlatformRole): string {
  return role
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

export function statusLabel(status: PlatformMembershipStatus): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

/** One-line summary of each role, shown when inviting staff or changing a role. */
export const ROLE_DESCRIPTIONS: Record<PlatformRole, string> = {
  SUPER_ADMIN: "Everything, including assigning Super admins and deleting test tenants.",
  PLATFORM_ADMIN: "Runs the platform: tenants, staff (except Super admins), pricing, flags and releases.",
  OPERATIONS_ADMIN: "Runs tenants day to day: onboarding, suspension, invites, support and incidents. No pricing or roles.",
  RELEASE_MANAGER: "Deployments, APK releases and incidents.",
  SECURITY_ADMIN: "Sessions, MFA, audit and incidents; can manage observer roles.",
  FINANCE_ADMIN: "Billing, pricing and subscription activation. Read-only on tenants.",
  SUPPORT_ADMIN: "Looks up tenants and users, reads their audit trail and sends password resets. Changes nothing else.",
  CLINICAL_GOVERNANCE: "Clinical simulations and the test centre.",
  STAKEHOLDER: "Read-only dashboards.",
  BOARD_OBSERVER: "Read-only dashboards.",
  INVESTOR_OBSERVER: "Read-only business metrics.",
  TECHNICAL_OBSERVER: "Read-only technical dashboards and system health.",
  AUDITOR: "Read-only auditor: every tenant, audit trail, finance, security and system health. Changes nothing.",
  READ_ONLY_OBSERVER: "Read-only dashboards.",
};

/**
 * Capabilities whose use additionally needs a fresh authenticator code
 * (POST /api/platform/mfa/step-up within the last 5 minutes), checked on the
 * server by requireRecentStepUp in lib/platform/step-up.ts.
 */
export const STEP_UP_CAPABILITIES: PlatformCapability[] = [
  "tenant.purge",
  "tenant.impersonate",
  "user.role.manage",
  "user.mfa.manage",
];

/**
 * The capability needed to open each console page, enforced on the server by
 * requirePlatformPage(path) in lib/platform/auth.ts (the sidebar is filtered
 * from the same map, but hiding a link is not what protects the page).
 * Longest-prefix match: /platform/tenants/abc uses /platform/tenants.
 */
export const NAV_CAPABILITY_MAP: Record<string, PlatformCapability> = {
  "/platform": "platform.dashboard.read",
  "/platform/performance": "platform.dashboard.read",
  "/platform/test-center": "test_center.read",
  "/platform/registry": "product.read",
  "/platform/monitoring": "system_health.read",
  "/platform/simulation": "simulation.read",
  "/platform/events": "event.read",
  "/platform/lab": "product.read",
  "/platform/intelligence": "analytics.read",
  "/platform/icd11": "product.read",
  "/platform/guidelines": "product.read",
  "/platform/modules": "capability.read",
  "/platform/integrations": "integration.read",
  "/platform/incidents": "incident.read",
  "/platform/applications": "tenant.manage",
  "/platform/approvals": "tenant.manage",
  "/platform/sales": "platform.crm.manage",
  "/platform/commercial/leads": "platform.crm.read",
  "/platform/commercial/meetings": "platform.crm.read",
  "/platform/commercial/pricing": "platform.pricing.read",
  "/platform/commercial/subscriptions": "platform.subscription.read",
  "/platform/tenants": "tenant.read",
  "/platform/tenants/provision": "tenant.manage",
  "/platform/hospitals": "tenant.read",
  "/platform/hospitals/new": "tenant.manage",
  "/platform/facilities": "tenant.read",
  "/platform/facilities/new": "tenant.manage",
  "/platform/pharmacies/onboard": "tenant.manage",
  "/platform/users": "user.read",
  "/platform/access": "user.read",
  "/platform/pharmacy-network": "tenant.read",
  "/platform/support": "tenant.read",
  "/platform/broadcasts": "platform.crm.manage",
  "/platform/billing": "finance_summary.read",
  "/platform/receipts": "finance_summary.read",
  "/platform/subscriptions": "platform.subscription.read",
  "/platform/analytics": "analytics.read",
  "/platform/public-health": "analytics.read",
  "/platform/security": "security_summary.read",
  "/platform/audit-log": "audit.read",
  "/platform/flags": "feature_flag.manage",
  "/platform/dhis2": "integration.read",
  "/platform/database": "system_health.read",
  "/platform/deployments": "deployment.read",
  "/platform/mobile": "deployment.read",
  "/platform/health": "system_health.read",
  "/platform/system": "system_health.read",
  "/platform/settings": "platform.dashboard.read",
};

export function navRequiresCapability(href: string): PlatformCapability {
  const path = href.split("?")[0]!.replace(/\/+$/, "") || "/platform";
  let best: string | null = null;
  for (const prefix of Object.keys(NAV_CAPABILITY_MAP)) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.length) best = prefix;
    }
  }
  return best ? NAV_CAPABILITY_MAP[best]! : "platform.dashboard.read";
}
