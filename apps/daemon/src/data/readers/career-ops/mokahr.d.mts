/** Types for the copied career-ops provider (plain ESM, not type-checked here). */
declare const provider: { id: string; fetch(entry: any, ctx: any): Promise<any[]> };
export default provider;
export function decryptMokaHrEnvelope(envelope: { data?: string; necromancer?: string }): any;
export function parseMokaHrJobs(decrypted: any, companyName: string, tenantBaseUrl: string): { title: string; url: string; company: string; location: string; description?: string; postedAt?: number }[];
