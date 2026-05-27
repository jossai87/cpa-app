/**
 * Tool: get_vendor_contacts
 *
 * Look up contact information for one or more vendors from the store's
 * vendor directory. Returns phone, email, website, rep details, and account
 * number. When `vendor_name` is omitted, returns all vendors.
 *
 * Lifted verbatim from `case 'get_vendor_contacts':` in
 * `lambda/chat/index.ts`. No behaviour change.
 */

import { VENDOR_CONTACTS } from '../../shared/vendorContacts';
import { lookupVendor } from '../helpers';

export interface GetVendorContactsArgs {
  /** Vendor name to look up (e.g. "Brooks", "Yaleet"). Empty/omitted returns all. */
  vendor_name?: string;
}

export async function getVendorContacts(args: GetVendorContactsArgs): Promise<string> {
  const vendorName = args.vendor_name;
  if (vendorName && vendorName.trim()) {
    const match = lookupVendor(vendorName.trim());
    if (!match) {
      return JSON.stringify({
        found: false,
        searched: vendorName,
        message: `No contact info found for "${vendorName}" in the vendor directory. Try get_purchasing to see the full vendor list from Heartland.`,
      });
    }
    const { key, data } = match;
    return JSON.stringify({
      found: true,
      vendorName: key,
      aliases: data.aliases ?? [],
      phone: data.phone ?? null,
      email: data.email ?? null,
      website: data.website ?? null,
      rep: data.rep ? {
        name: data.rep.name,
        phone: data.rep.phone ?? null,
        email: data.rep.email ?? null,
        accountNumber: data.rep.account ?? null,
      } : null,
    });
  }
  // Return all vendors
  const all = Object.entries(VENDOR_CONTACTS).map(([key, data]) => ({
    vendorName: key,
    aliases: data.aliases ?? [],
    phone: data.phone ?? null,
    email: data.email ?? null,
    website: data.website ?? null,
    rep: data.rep ? {
      name: data.rep.name,
      phone: data.rep.phone ?? null,
      email: data.rep.email ?? null,
      accountNumber: data.rep.account ?? null,
    } : null,
  }));
  return JSON.stringify({ vendors: all, count: all.length });
}
