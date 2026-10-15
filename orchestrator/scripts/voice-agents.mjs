// Creates or updates Orchy and every agent in orchestrator/voice-agents.json as ElevenLabs voice agents
// (names, voices, prompts from the agent files, tools, transfers). Safe to re-run after agents change.
// Run: node orchestrator/scripts/voice-agents.mjs
import { sync } from '../lib/voiceagents.mjs';

try {
  await sync();
  console.log('Voice agents in sync.');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
