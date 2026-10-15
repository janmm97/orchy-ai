// DeepSeek Harness (`dsh`): the Cordis patch Orchy writes into the workspace's DSH_HOME before every ACP run. Pure functions.
//
// Permissions in dsh are a Cordis plugin (@deepseek-ai/dsh-permission-presets): a preset = sandbox mode + approval
// policy. Orchy pins the `workspace-write` preset (writes confined to the workspace, approval `ask`) and sets
// DSH_PERMISSION_MODE to match. It never writes `danger-full-access`/`never`, and strips any auto-approval ("Auto
// review") plugin from the profile's patch. The format below follows the docs (patch = list of { id, config });
// the exact preset schema is not fully documented, so only the documented `defaultPreset` key is written.
import YAML from 'yaml';

export const DSH_PROFILE = 'acp';
export const DSH_PRESETS_ID = '@deepseek-ai/dsh-permission-presets';
export const DSH_PERMISSION_MODE = 'workspace-write';
const AUTO = /auto[-_ ]?(approv|review)|approval[-_ ]?review/i;
const isAuto = e => AUTO.test(String(e?.id || '')) || AUTO.test(JSON.stringify(e?.config ?? ''));
const isPresets = e => String(e?.id || '').includes('permission-presets');

/** The profile's existing cordis.patch.yml text (or '') → the text Orchy writes. */
export function buildDshPatchYaml(existingText = '') {
  let cur = [];
  try { const j = YAML.parse(existingText || ''); if (Array.isArray(j)) cur = j; } catch { cur = []; }
  const kept = cur.filter(e => e && typeof e === 'object' && !isAuto(e) && !isPresets(e));
  kept.push({ id: DSH_PRESETS_ID, config: { defaultPreset: DSH_PERMISSION_MODE } });
  return `# Written by Orchy before every run: the workspace-write permission preset (approval: ask), no auto-approval plugin.\n# Provider and model entries are yours; Orchy keeps them.\n${YAML.stringify(kept)}`;
}

/** Is a patch text safe by Orchy's rules? */
export function dshPatchLooksSafe(text) {
  let j;
  try { j = YAML.parse(text || ''); } catch { return false; }
  if (!Array.isArray(j)) return false;
  if (j.some(isAuto)) return false;
  const p = j.find(isPresets);
  return p?.config?.defaultPreset === DSH_PERMISSION_MODE && !/danger-full-access|never/i.test(JSON.stringify(p));
}

/** The command-line arguments: the ACP profile, nothing else (no --patch overlay, no mode flags). */
export const dshArgs = () => ['--profile', DSH_PROFILE];

/** `dsh --dump-config` text → { providers, model } (defensive: output format isn't documented). */
export function parseDshConfig(text) {
  const t = String(text || '');
  const providers = new Set();
  for (const m of t.matchAll(/\bllm-([a-z0-9][a-z0-9-]*)/gi)) providers.add(m[1].replace(/^pi-ai$/i, 'custom'));
  const model = (t.match(/^\s*(?:model|defaultModel)\s*[:=]\s*["']?([^\s"',]+)/im) || [])[1] || null;
  return { providers: [...providers], model };
}
