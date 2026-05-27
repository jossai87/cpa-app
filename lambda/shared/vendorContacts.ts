/**
 * Vendor contact directory (mirrors SalesRevenue.tsx).
 *
 * Single source of truth for vendor phone, email, rep, and account info.
 * Consumed by the Sales chat / FS Assistant `get_vendor_contacts` tool, which
 * uses this directory before falling back to the Gmail cache.
 *
 * Extracted from `lambda/chat/index.ts` so the AgentCore container can import
 * it alongside the legacy `/pos/chat` Lambda. Pure data — no behavior change.
 */

export interface VendorContactRep {
  name: string;
  phone?: string;
  email?: string;
  account?: string;
}

export interface VendorContact {
  phone?: string;
  email?: string;
  website?: string;
  rep?: VendorContactRep;
  aliases?: string[];
}

export const VENDOR_CONTACTS: Record<string, VendorContact> = {
  'BROOKS':           { phone: '1-800-227-6657', email: 'retailer@brooksrunning.com', website: 'https://www.brooksrunning.com', rep: { name: 'Jacob Brooks — Territory Mgr, North TX/OK', phone: '239-839-7971', email: 'Jacob.brooks@brooksrunning.com' } },
  'SAUCONY':          { phone: '1-800-282-6575', email: 'customerservice@saucony.com', website: 'https://www.saucony.com' },
  'DANSKO':           { phone: '1-800-326-7564', email: 'moreinfo@dansko.com', website: 'https://www.dansko.com' },
  'VIONIC':           { phone: '1-800-832-9255', email: 'info@vionicshoes.com', website: 'https://www.vionicshoes.com' },
  'AETREX':           { phone: '1-888-526-2739', email: 'help@aetrex.com', website: 'https://www.aetrex.com' },
  'DREW':             { phone: '1-800-837-3739', email: 'customerservice@drewshoe.com', website: 'https://www.drewshoe.com' },
  'FINN USA':         { phone: '1-877-353-6642', email: 'orders@finncomfortusa.net', website: 'https://www.finncomfortusa.net' },
  'MEPHISTO':         { phone: '1-615-771-5900', email: 'info@mephistousa.com', website: 'https://mephistousa.com' },
  'ROCKPORT':         { phone: '1-800-762-5767', email: 'consumercare@help.rockport.com', website: 'https://www.rockport.com' },
  'OLUKAI':           { phone: '1-877-789-5131', email: 'info@olukai.com', website: 'https://olukai.com' },
  'HAFLINGER COMFORT FOOTWEAR': { phone: '1-800-551-7556', email: 'help@haflinger.com', website: 'https://us.haflinger.com' },
  'WALDLAUFER':       { website: 'https://waldlauferfootwear.com' },
  'GIESSWEIN':        { phone: '+43-5337-6135-0', email: 'shop@giesswein.com', website: 'https://us.giesswein.com' },
  'SANITA':           { website: 'https://www.sanita.com' },
  'FEETURES':         { email: 'hello@feetures.com', website: 'https://feetures.com' },
  'CALERES':          { phone: '1-888-509-8200', email: 'retailerservices@caleres.com', website: 'https://www.caleres.com' },
  'P.W.MINOR':        { phone: '1-585-343-1500', email: 'info@pwminor.com', website: 'https://www.pwminor.com' },
  'PEDAG INTERNATIONAL': { email: 'info@pedag.com', website: 'https://pedagusa.com' },
  'EARTH BRAND SHOES': { website: 'https://www.earthbrands.com' },
  'KUMFS/ZIERA':      { website: 'https://www.zierausa.com' },
  'YALEET':           { phone: '516-465-6268', website: 'https://www.naot.com', aliases: ['NAOT'], rep: { name: 'Joey DeWitt — Sales Rep', phone: '817-975-3365' } },
  'AMERIBAG':         { phone: '1-800-AMERIBAG', website: 'https://www.ameribag.com' },
  'FIDELIO':          { phone: '414-778-2288', website: 'https://www.berkemann.com', aliases: ['RUBY LEATHER', 'FIDELIO (RUBY LEATHER)'] },
  'BERKEMANN':        { website: 'https://www.berkemann.com' },
  'JUSTIN BLAIR':     { phone: '800-566-0664', website: 'https://www.burtendistribution.com' },
  'SHU-RE-NU':        { email: 'tbogumill@shu-re-nu.com', rep: { name: 'Tammy Bogumill' } },
  'INSTRIDE':         { phone: '866-969-3338', website: 'https://www.xeleroshoes.com', aliases: ['XELERO'] },
  'THORLO':           { website: 'https://www.thorlo.com' },
  'HOKA':             { phone: '1-888-463-4652', website: 'https://www.hoka.com' },
  'APEX':             { phone: '800-252-2739', email: 'Lisa.fryberger@ohi.net', website: 'https://www.apexfoot.com', rep: { name: 'Lisa Fryberger', phone: '631-615-4176', account: '97378' } },
  'PEDORS':           { phone: '1-800-750-6729', website: 'https://www.pedors.com' },
  'PEDIFIX':          { phone: '1-800-424-5561', website: 'https://www.pedifix.com' },
};
