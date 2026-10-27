// Campaign section of the settings form. Field names match
// lib/site-campaign-form.ts.

import type { Campaign } from '../lib/site-org-settings.ts';

const value = (n: number | undefined): string => (n ? String(n) : '');

export function renderCampaignSettings(c: Campaign | undefined): string {
  return `<h2 class="rkr-admin-settings-section">Campaign</h2>
  <p class="rkr-admin-settings-note" style="grid-column:1/-1">Progress blocks set to the site campaign show these figures on every page.</p>
  <label for="rkr-settings-campaign-goal">Goal</label>
  <input id="rkr-settings-campaign-goal" name="campaignGoal" type="text" inputmode="numeric" value="${value(c?.goal)}"/>
  <label for="rkr-settings-campaign-raised">Raised</label>
  <input id="rkr-settings-campaign-raised" name="campaignRaised" type="text" inputmode="numeric" value="${value(c?.raised)}"/>`;
}
