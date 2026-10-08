import { test, expect } from '@playwright/test';
import { adminPortalSSODefaults } from '@lib/env';
import { isAdminPortalSSO } from '@lib/adminPortalSSO';

// The admin portal's SAML sign-in (`boxyhq-saml` and `boxyhq-saml-idplogin` in
// pages/api/auth/[...nextauth].ts) must only accept a profile issued for the admin-portal
// tenant and product. Jackson hands out codes for every customer connection, and the
// code exchange alone does not tie a code to the admin portal (DEV-1031).

const { tenant, product } = adminPortalSSODefaults;

test.describe('admin portal SSO tenant check', () => {
  test('accepts the admin-portal tenant and product, SP- and IdP-initiated', () => {
    expect(isAdminPortalSSO({ tenant, product })).toBe(true);
    expect(isAdminPortalSSO({ tenant, product, isIdPFlow: true, providerName: 'idp' })).toBe(true);
  });

  for (const [name, requested] of Object.entries({
    'a customer tenant (IdP-initiated)': { tenant: 'customer', product: 'kvasir', isIdPFlow: true },
    'a customer tenant (SP-initiated)': { tenant: 'customer', product: 'kvasir', redirect_uri: 'x' },
    'the admin tenant with another product': { tenant, product: 'kvasir' },
    'another tenant with the admin product': { tenant: 'customer', product },
    'tenant and product swapped': { tenant: product, product: tenant },
    'no tenant or product': {},
    'no requested block': undefined,
    null: null,
  })) {
    test(`refuses ${name}`, () => {
      expect(isAdminPortalSSO(requested)).toBe(false);
    });
  }
});
