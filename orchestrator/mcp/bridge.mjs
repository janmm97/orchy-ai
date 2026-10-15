#!/usr/bin/env node
// Orchy bridge: a tiny stdio MCP server that every agent run gets as "jos".
// It turns tool calls into dashboard pop-ups and waits for the owner's answer (or, in a run a client
// started from their own page, the client's: JOS_PERSON names them).
//   ask_user             → "From: <agent>" window with a reply box
//   request_connections  → "A message from AI Agent Builder" window with connection toggles
//   jev_pick_tools       → Jev picks a new agent's connections and actions (builder only)
//   voice_agent          → creates/updates the agent's ElevenLabs voice agent (builder only)
//   approval             → permission prompt tool: Approve/Deny window for outward actions
//   report_done / note   → reports back to Orchy (logged to LOGS.md)
//   delegate             → a department head hands a task to its team agent (only listed when JOS_TEAM is set)
//   call_owner             → rings the owner in the dashboard for a live voice call (not in a client's run)
//   huddle               → a C-suite agent pulls another agent of its workspace into a huddle (only listed when JOS_HUDDLE_WITH is set)
//   huddle_reply         → what the agent says in its turn of a huddle (a huddle turn has only this, note and approval)
import readline from 'node:readline';
import { ownerName } from '../lib/env.mjs';

const URL_BASE = process.env.JOS_URL || 'http://127.0.0.1:8008';
const TOKEN = process.env.JOS_TOKEN || '';
const RUN_ID = process.env.JOS_RUN_ID || '';
// who the agent works for in this run: the owner, or a client who started it from their own page
const PERSON = process.env.JOS_PERSON || ownerName();
// a department head's own run: the team it may hand work to (the server checks every hand-off again)
let TEAM = [];
try { TEAM = JSON.parse(process.env.JOS_TEAM || '[]'); } catch {}
// a C-suite agent's own run: who it may start a huddle with (the server checks every huddle again)
let HUDDLE_WITH = [];
try { HUDDLE_WITH = JSON.parse(process.env.JOS_HUDDLE_WITH || '[]'); } catch {}
// a turn in a huddle (huddle.mjs): talk only, so no questions, reports, calls or builder tools
const HUDDLE = process.env.JOS_HUDDLE === '1';

const HUDDLE_REPLY = {
  name: 'huddle_reply',
  description: 'Huddle only: end your turn with what you say to the others in the huddle. Call it exactly once per turn, then stop. When Orchy asks for the agreement, fill in agreement too.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'What you say to the others: short and concrete, under ~150 words.' },
      ready: { type: 'boolean', description: 'True once you two agree on what to do and who does it.' },
      questions_for_owner: { type: 'array', items: { type: 'string' }, description: `Things only ${ownerName()} can answer. They wait for the agreement; don't guess them.` },
      invite: {
        type: 'object',
        description: 'Bring another agent of this workspace into the huddle, when the talk needs what they know or do. They join right away and speak next, having read everything said so far. Not while writing the agreement.',
        properties: {
          agent: { type: 'string', description: 'Their slug, from the list in your instructions.' },
          why: { type: 'string', description: 'One line: what you need from them. Everyone reads it.' },
        },
        required: ['agent', 'why'],
      },
      agreement: {
        type: 'object',
        description: 'Only when Orchy asks you to wrap up.',
        properties: {
          summary: { type: 'string', description: `What you agreed, in a few sentences, for ${ownerName()}.` },
          decisions: { type: 'array', items: { type: 'string' } },
          work: {
            type: 'array',
            description: `Each agent's part once ${ownerName()} approves.`,
            items: { type: 'object', properties: { agent: { type: 'string', description: 'The agent\'s slug.' }, task: { type: 'string', description: 'A complete task: what to do, with the names, links, IDs and details from the talk.' } }, required: ['agent', 'task'] },
          },
          questions_for_owner: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'work'],
      },
    },
    required: ['message'],
  },
};

const ALL_TOOLS = [
  {
    name: 'ask_user',
    description: `Ask ${PERSON} (your human) a question and wait for the answer. Use whenever something material is unclear: which recipient/account, ambiguous scope, missing info, or a judgement call. Ask one clear question; offer options when you can.`,
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in plain words.' },
        context: { type: 'string', description: 'What you are unsure about and why (shown under the question).' },
        options: { type: 'array', items: { type: 'string' }, description: `Optional suggested answers ${PERSON} can click.` },
      },
      required: ['question'],
    },
  },
  {
    name: 'request_connections',
    description: `Agent Builder only: when unsure which connections a new agent should get, show ${ownerName()} every connection in this workspace (One + external MCP) with toggles. Your suggestions are pre-selected. Returns the connections ${ownerName()} switched on.`,
    inputSchema: {
      type: 'object',
      properties: {
        agent_name: { type: 'string', description: 'Name of the agent being built.' },
        purpose: { type: 'string', description: 'One line on what the agent will do.' },
        message: { type: 'string', description: `What you are unsure about, addressed to ${ownerName()}.` },
        suggested: { type: 'array', items: { type: 'string' }, description: 'Connection keys you suggest (One keys like live::gmail::..., or mcp:<name>).' },
        suggested_access: { type: 'object', additionalProperties: { type: 'string', enum: ['read', 'full'] }, description: 'Optional: access per suggested key (from jev_pick_tools), e.g. {"live::gmail::...": "full"}. Unlisted keys start at read.' },
      },
      required: ['agent_name', 'message'],
    },
  },
  {
    name: 'jev_pick_tools',
    description: 'Agent Builder only: after `one --agent list` and `one --agent actions find`, let Jev decide which connections the new agent gets (skip / read / full) and which of the actions you found it should use. Pass every candidate action. Returns Jev\'s picks with confidence, plus notes on anything Jev was unsure about.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_name: { type: 'string', description: 'Name of the agent being built.' },
        job: { type: 'string', description: `The agent's job in a few sentences: trigger, inputs, output and who sees it, cadence, which account(s) ${ownerName()} named.` },
        actions: {
          type: 'array',
          description: 'Candidate actions from `one --agent actions find`, across every platform the job might need.',
          items: {
            type: 'object',
            properties: {
              platform: { type: 'string', description: 'Platform slug, e.g. gmail.' },
              action_id: { type: 'string', description: 'The action id exactly as returned.' },
              title: { type: 'string', description: 'The action title.' },
              method: { type: 'string', description: 'HTTP method if shown (GET, POST…).' },
              kind: { type: 'string', enum: ['read', 'write'], description: 'Your reading of it. Orchy re-checks each action the way its approval gate does, and that verdict (shown as [read]/[write] in the result) is what read access allows.' },
            },
            required: ['platform', 'action_id', 'title'],
          },
        },
      },
      required: ['agent_name', 'job', 'actions'],
    },
  },
  {
    name: 'voice_agent',
    description: `Agent Builder only: once an agent file is written and validated (new, or its role, description or call_name changed), create or update its ElevenLabs voice agent so ${ownerName()} can call it by name. Gives a new agent a voice, refreshes its prompt, and updates Orchy's team list and call transfers. Takes a few seconds. Returns the name and voice it got.`,
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'The agent\'s slug (its file name in .claude/agents without .md).' } },
      required: ['slug'],
    },
  },
  {
    name: 'report_done',
    description: `Report back to Orchy. Call exactly once at the very end, also when blocked or failed. Orchy logs it to LOGS.md and tells ${ownerName()}.`,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['completed', 'partial', 'blocked', 'failed'] },
        summary: { type: 'string', description: 'Detailed, honest summary: what you did, what you found or produced, what you could not do and why.' },
        actions_taken: { type: 'array', items: { type: 'string' }, description: 'Each meaningful action, e.g. "Sent email to x@y.com via the shared gmail".' },
        outputs: { type: 'array', items: { type: 'string' }, description: 'Links, file paths, IDs, or results produced.' },
        follow_ups: { type: 'array', items: { type: 'string' }, description: `Anything ${ownerName()} should do or decide next.` },
      },
      required: ['status', 'summary'],
    },
  },
  {
    name: 'note',
    description: `Post a short progress note ${PERSON} sees live. Use sparingly on long tasks.`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  ...(TEAM.length ? [{
    name: 'delegate',
    description: `Hand a task to an agent on your team and wait for its report. It runs as its own Orchy run, with its own connections and instructions; ${ownerName()} approves its decisions as usual. It can't see your conversation, so give it everything it needs. Your team:\n${TEAM.map(t => `- ${t.slug}: ${t.name}. ${t.does}`).join('\n')}`,
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: TEAM.map(t => t.slug), description: 'The team agent\'s slug.' },
        task: { type: 'string', description: 'A complete, self-contained task: what to do, the inputs, links and IDs it needs, constraints, and what to hand back.' },
      },
      required: ['agent', 'task'],
    },
  }] : []),
  ...(HUDDLE_WITH.length ? [{
    name: 'huddle',
    description: `Start a huddle: you and one other agent of this workspace talk something through, turn by turn, and you write up what you agree. Use it when you need another agent's thinking or input before deciding, not to hand off work (that's delegate). You open, and you wait here until it ends (it can take several minutes). Talk only: nothing changes during it, and nothing in the agreement runs until ${ownerName()} approves it in the dashboard. The other agent can't see your conversation, so the topic must stand on its own. Who you can huddle with:\n${HUDDLE_WITH.map(t => `- ${t.slug}: ${t.name}. ${t.does}`).join('\n')}`,
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: HUDDLE_WITH.map(t => t.slug), description: 'The other agent\'s slug.' },
        topic: { type: 'string', description: 'What the two of you should work out, complete and self-contained: the goal, the context and facts from your task (names, links, IDs), what you need from them, and the decision to reach.' },
      },
      required: ['agent', 'topic'],
    },
  }] : []),
  ...(PERSON === ownerName() && !process.env.JOS_NO_CALL ? [{
    name: 'call_owner',
    description: `Ring ${ownerName()} in the Orchy dashboard for a live voice call with you (your voice agent, by name), and wait until the call is over. Use it when ${ownerName()} asked you to call ("call me when you're done": ring right before report_done and tell ${ownerName()} what you found; "call me if you get stuck": ring instead of only asking), or for something urgent that can't wait for ${ownerName()} to see an ask_user question: a deadline about to pass, something going wrong, a decision that blocks everything. At most twice per task. ${ownerName()} may not pick up. Returns the call's transcript, so act on what ${ownerName()} said.`,
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: `Why you're calling, in one or two plain sentences. Your voice agent says it first thing, so include what you need from ${ownerName()}.` } },
      required: ['reason'],
    },
  }] : []),
  {
    name: 'approval',
    description: 'Internal: permission prompt handled by the orchestrator. Do not call directly.',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name', 'input'],
    },
  },
];

async function post(path, body) {
  const res = await fetch(`${URL_BASE}/api/bridge/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-jos-token': TOKEN },
    body: JSON.stringify({ runId: RUN_ID, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `orchestrator ${res.status}`);
  return json;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/**
 * Long-poll a bridge GET until `settled(body)` returns a result. While Orchy is down it keeps trying; a refusal is
 * final (`refused(body)`: a restarted Orchy doesn't know this run any more), and an odd answer waits before asking again.
 */
async function poll(url, settled, refused) {
  for (;;) {
    let res, body;
    try {
      res = await fetch(`${URL_BASE}/api/bridge/${url}`, { headers: { 'x-jos-token': TOKEN } });
      body = await res.json().catch(() => null);
    } catch {
      await sleep(3000); // orchestrator restarting: keep waiting
      continue;
    }
    if (!res.ok) return refused(body || {});
    const done = body && typeof body === 'object' ? settled(body) : null;
    if (done) return done;
    if (!body || typeof body !== 'object' || !('status' in body || 'done' in body)) await sleep(3000);
  }
}

const waitAnswer = itemId => poll(`wait/${itemId}`, item => (item.status && item.status !== 'pending' ? item : null), () => ({ status: 'expired' }));

/** Wait for a team agent's run to end; resolves with its report. */
const waitSubRun = subId => poll(`subrun/${subId}?parent=${encodeURIComponent(RUN_ID)}`, r => (r.done ? r : null),
  r => ({ agentName: 'The team agent', outcome: 'failed', error: r.error || 'Orchy lost track of that run.' }));

/** Wait for a huddle this run started to end (agreed, stopped or failed). */
const waitHuddle = hid => poll(`huddle/${hid}?run=${encodeURIComponent(RUN_ID)}`, r => (r.done ? r : null), r => ({ status: 'lost', note: r.error || 'Orchy lost track of that huddle.' }));

/** Wait for a call to settle (the owner picked up and hung up, or didn't). */
const waitCall = callId => poll(`call/${callId}?run=${encodeURIComponent(RUN_ID)}`, r => (r.done ? r : null), r => ({ status: 'lost', error: r.error }));

const text = t => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }] });

async function callTool(name, args) {
  switch (name) {
    case 'ask_user': {
      const { itemId } = await post('ask', args);
      const item = await waitAnswer(itemId);
      const who = item.askee || PERSON;
      if (item.status === 'expired') return text(`${who} did not answer (the run is ending). Stop and report what you have.`);
      return text(`${who} answered: ${item.answer?.text ?? item.answer}`);
    }
    case 'request_connections': {
      const { itemId } = await post('connections', args);
      const item = await waitAnswer(itemId);
      if (item.status === 'expired') return text(`No answer from ${ownerName()}. Use only the connections you are certain about and say so in your report.`);
      const sel = item.answer?.selected || [];
      const lines = sel.map(c => `- ${c.name} — ${c.source === 'mcp' ? `MCP server "${c.name}"` : `platform ${c.platform}, key ${c.key}`}${c.access ? `, access: ${c.access}` : ''}`);
      return text(`${ownerName()} switched on these connections for ${args.agent_name}:\n${lines.join('\n') || '(none)'}${item.answer?.note ? `\n\n${ownerName()}'s note: ${item.answer.note}` : ''}\n\nUse exactly these in the agent's connections.`);
    }
    case 'jev_pick_tools': {
      let r;
      try { r = await post('jev-tools', args); }
      catch (e) { return text(`Jev couldn't pick the tools (${e.message}). Choose them yourself, least privilege, and confirm with ${ownerName()} via request_connections.`); }
      const conns = r.connections.map(c => `- ${c.name} — key \`${c.key}\` — access: ${c.access} (confidence ${c.confidence})`).join('\n') || '- (none)';
      const acts = r.actions.map(a => `- ${a.platform}: ${a.title} [${a.kind}] — \`${a.action_id}\` (confidence ${a.confidence})`).join('\n') || '- (none)';
      return text(`Jev's picks for ${args.agent_name}:

Connections:
${conns}

Actions to use:
${acts}
${r.skippedActions.length ? `\nSkipped actions: ${r.skippedActions.join('; ')}\n` : ''}${r.notes.length ? `\nNotes:\n${r.notes.map(n => `- ${n}`).join('\n')}\n` : ''}${r.unsure.length ? `\nJev was unsure about: ${r.unsure.join('; ')}. Raise these with ${ownerName()}.\n` : ''}
Next: confirm with ${ownerName()} via request_connections, passing these connection keys as \`suggested\` and their access as \`suggested_access\` (mention anything Jev was unsure about in the message). Build the agent with what ${ownerName()} switches on, and name the chosen actions in its Connections table and How to work.`);
    }
    case 'voice_agent': {
      let v;
      try { v = await post('voice-agent', args); }
      catch (e) { return text(`The voice agent wasn't set up: ${e.message}. Say so in your report (status partial) with this error; Orchy retries it when your run ends. Don't tell ${ownerName()} to run scripts.`); }
      const renamed = v.callName && v.callName !== v.name
        ? `\n\n"${v.callName}" was taken or not a plain first name, so the voice agent is ${v.name}. Set call_name: ${v.name} in the file (and "You are ${v.name}" in Identity) so they match.` : '';
      return text(`${v.name} is on voice${v.isNew ? '' : ' (updated)'}: ElevenLabs agent ${v.agentId}, ${v.gender} voice "${v.voice}". ${ownerName()} can call ${v.name} from the dashboard, and Orchy can put ${ownerName()} through. Tell ${ownerName()} this in your report.${renamed}`);
    }
    case 'report_done': {
      await post('report', args);
      return text('Reported to Orchy. It is logged in LOGS.md. Finish with a one-line final message.');
    }
    case 'note': {
      await post('note', args);
      return text('Noted.');
    }
    case 'delegate': {
      let sub;
      try { sub = await post('delegate', args); }
      catch (e) { return text(`Not handed over: ${e.message}`); }
      const r = await waitSubRun(sub.runId);
      const list = (label, xs) => (xs?.length ? `\n${label}:\n${xs.map(x => `- ${x}`).join('\n')}` : '');
      return text(`${r.agentName} finished: ${r.outcome} (run ${sub.runId}).
Summary: ${r.summary || r.error || '(no summary)'}${list('Actions taken', r.actions_taken)}${list('Outputs', r.outputs)}${list('Follow-ups', r.follow_ups)}

Check this before you rely on it, and say in your report_done what you handed to ${r.agentName} and what came back.`);
    }
    case 'huddle': {
      let st;
      try { st = await post('huddle', args); }
      catch (e) { return text(`No huddle: ${e.message}`); }
      const r = await waitHuddle(st.huddleId);
      const list = (label, xs) => (xs?.length ? `\n${label}:\n${xs.map(x => `- ${x}`).join('\n')}` : '');
      if (r.status === 'agreed' && r.agreement) {
        const g = r.agreement;
        return text(`Your huddle with ${st.with} ended in an agreement (${r.turns} turns, huddle ${st.huddleId}${r.taskDir ? `, transcript Tasks/${r.taskDir}/HUDDLE.md` : ''}).
Summary: ${g.summary}${list('Decisions', g.decisions)}${list(`Work once ${ownerName()} approves`, (g.work || []).map(w => `${w.agent}: ${w.task}`))}${list(`Questions for ${ownerName()}`, g.questions_for_owner)}

It's waiting for ${ownerName()} in the dashboard. Nothing in it runs until ${ownerName()} approves; then each part starts as its own run (yours resumes the huddle). Don't do that work here. Carry on with the rest of your task, and say in report_done that the agreement is waiting for ${ownerName()}.`);
      }
      return text(`Your huddle with ${st.with} ended without an agreement: ${r.status}${r.note ? ` (${r.note})` : ''}. ${ownerName()} can pick it up again from the huddle window. Carry on without it, and say so in report_done.`);
    }
    case 'call_owner': {
      let c;
      try { c = await post('call', args); }
      catch (e) { return text(`Didn't ring: ${e.message}. Carry on; if you need ${ownerName()}, use ask_user (it waits in the dashboard).`); }
      const r = await waitCall(c.callId);
      if (r.status === 'ended') {
        const said = r.transcript ? `\n\nWhat was said:\n${r.transcript}` : `\n\nThe transcript isn't available${r.error ? ` (${r.error})` : ''}.`;
        return text(`You talked to ${ownerName()}${r.seconds ? ` (${Math.max(1, Math.round(r.seconds / 60))} min)` : ''}.${r.summary ? `\nSummary: ${r.summary}` : ''}${said}\n\nAct on what ${ownerName()} said. Anything ${ownerName()} answered on the call through a question or approval already reached you as its answer.`);
      }
      if (r.status === 'cancelled') return text(`${ownerName()} dealt with it in the dashboard before picking up. Carry on.`);
      if (r.status === 'busy' || r.status === 'lost') return text(`${ownerName()} couldn't take the call (${r.status === 'busy' ? 'on another call' : r.error || 'Orchy lost track of it'}). Carry on; if you need an answer, use ask_user.`);
      return text(`${ownerName()} didn't pick up (${r.status === 'declined' ? 'declined' : 'missed'}). Orchy left ${ownerName()} a missed call with your reason. Carry on; if you need an answer, use ask_user.`);
    }
    case 'huddle_reply': {
      if (!HUDDLE) throw new Error('huddle_reply is only for a huddle turn');
      await post('huddle-reply', args);
      return text(args.agreement ? `Agreement handed to Orchy for ${ownerName()}. Your turn is over: finish with one short line.` : 'Passed on. Your turn is over: finish with one short line, no more tools.');
    }
    case 'approval': {
      const res = await post('approval', args);
      if (res.decision === 'allow') return text({ behavior: 'allow', updatedInput: args.input });
      if (res.decision === 'deny') return text({ behavior: 'deny', message: res.reason || 'Not allowed.' });
      const item = await waitAnswer(res.itemId);
      if (item.status === 'answered' && item.answer?.approve) return text({ behavior: 'allow', updatedInput: args.input });
      const who = item.askee || ownerName();
      const why = item.status === 'expired' ? `No answer from ${who}.` : `${who} denied this${item.answer?.note ? `: ${item.answer.note}` : '.'}`;
      return text({ behavior: 'deny', message: `${why} Do not retry it another way; adapt or ask ${PERSON} with ask_user.` });
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

const TOOLS = HUDDLE ? [HUDDLE_REPLY, ...ALL_TOOLS.filter(t => ['note', 'approval'].includes(t.name))] : ALL_TOOLS;

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'jos', version: '0.1.0' },
        instructions: HUDDLE ? 'Orchy orchestrator bridge: end each huddle turn with huddle_reply.' : 'Orchy orchestrator bridge: ask_user when unsure, report_done once at the end.',
      } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const result = await callTool(params.name, params.arguments || {});
        return send({ jsonrpc: '2.0', id, result });
      } catch (e) {
        return send({ jsonrpc: '2.0', id, result: { ...text(`Orchestrator error: ${e.message}`), isError: true } });
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});
