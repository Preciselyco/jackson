// Precisely (DEV-1031): the admin portal's SAML sign-in must only accept a profile issued for
// the admin-portal tenant and product, not one from any customer connection.
import { adminPortalSSODefaults } from '@lib/env';

export function isAdminPortalSSO(requested?: Record<string, unknown> | null): boolean {
  const { tenant, product } = adminPortalSSODefaults;
  return requested?.tenant === tenant && requested?.product === product;
}
