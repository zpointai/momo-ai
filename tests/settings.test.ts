// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// Isolated contract tests: these controlled records are never used by the application or captures.
import {expect,it} from 'vitest';
import {resolveRoute,settingsSections} from '../src/shared/modules';
import {searchSettings,settingEntries} from '../src/shared/settings-catalogue';
import {scheduledWindow} from '../src/shared/schedule-window';
import type {AgentRun,WorkflowPolicy} from '../src/shared/orchestration';
const policy={id:'00000000-0000-4000-8000-000000000001',accountId:'test-account',family:'briefing',enabled:true,level:'L1',version:1,maxLocalPerDay:1,schedule:{enabled:true,hour:9,minute:0,timezone:'Europe/Amsterdam'},updatedAt:'2026-09-24T00:00:00Z'} as WorkflowPolicy;
it('preserves old links and maps the new AI subsection links',()=>{
 for(const section of settingsSections)expect(resolveRoute('#settings/'+section)).toEqual({page:'settings',section});
 for(const section of ['usage','limits','providers'])expect(resolveRoute('#settings/ai/'+section)).toEqual({page:'settings',section});
 expect(resolveRoute('#automations')).toEqual({page:'settings',section:'automation'});expect(resolveRoute('#memory')).toEqual({page:'settings',section:'learning'});
});
it('has unique static search entries for all functional settings sections and recognizes task synonyms',()=>{
 expect(new Set(settingEntries.map(e=>e.id)).size).toBe(settingEntries.length);expect(searchSettings('budget')[0].section).toBe('limits');expect(searchSettings('oauth')[0].section).toBe('accounts');expect(searchSettings('   ')).toEqual([]);expect(searchSettings('secret-value-canary')).toEqual([]);
 for(const section of settingsSections.filter(s=>!['overview','ai'].includes(s)))expect(settingEntries.some(e=>e.section===section)).toBe(true);
});
it('shares the exact local minute catch-up boundary, without claiming a future eligible run',()=>{
 expect(scheduledWindow(policy,[],Date.parse('2026-09-24T06:59:59Z')).eligible).toBe(false);
 expect(scheduledWindow(policy,[],Date.parse('2026-09-24T07:00:00Z')).eligible).toBe(true);
 expect(scheduledWindow(policy,[],Date.parse('2026-09-24T09:00:59Z')).eligible).toBe(true);
 expect(scheduledWindow(policy,[],Date.parse('2026-09-24T09:01:00Z')).reason).toContain('closed');
 const run={policy,event:{trigger:'schedule'},createdAt:'2026-09-24T07:10:00Z'} as AgentRun;
 expect(scheduledWindow(policy,[run],Date.parse('2026-09-24T08:00:00Z')).reason).toContain('already recorded');
 expect(scheduledWindow(policy,[run],Date.parse('2026-09-25T07:00:00Z')).eligible).toBe(true);
});
