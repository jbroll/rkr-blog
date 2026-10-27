// Turns the settings form's campaign fields into a site.json patch. An
// empty pair clears the campaign; a missing pair leaves it alone.

import type { OrgSiteFields } from './site-org-settings.ts';

type Body = Record<string, unknown>;

const WHOLE = /^\d{1,12}$/;

function figure(v: unknown, label: string): number | { error: string } {
  const s = typeof v === 'string' ? v.trim().replace(/,/g, '') : '';
  if (!s) return 0;
  return WHOLE.test(s) ? Number(s) : { error: `${label} must be a whole number, 0 or more.` };
}

export function parseCampaignForm(body: Body): { patch: OrgSiteFields } | { error: string } {
  if (!('campaignGoal' in body) && !('campaignRaised' in body)) return { patch: {} };
  const goal = figure(body.campaignGoal, 'Campaign goal');
  if (typeof goal !== 'number') return goal;
  const raised = figure(body.campaignRaised, 'Campaign raised');
  if (typeof raised !== 'number') return raised;
  return { patch: { campaign: { goal, raised } } };
}
