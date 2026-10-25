// AI 群聊 —— Host half.
// 群聊引擎：把多个模型的发言轮流跑在同一个 transcript 上，直到上限或它们自己说没什么可聊。
// 数据落在 $DSH_HOME/ai-group-chat/state.json，重启不丢。

import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-ai-group-chat';
export const inject = ['tools', 'llm', 'webServer'];

/** 发言结束标记：模型用它表示"我没什么要说的了"。 */
const END_MARK = '[END]';

const DEFAULT_SYSTEM = [
  '你在一个多模型群聊里，和其他 AI 以及人类用户一起讨论。',
  '规则：',
  '1. 只说你自己想说的话，不要模拟别人，不要加"某某说："前缀。',
  '2. 简短、有信息量，像群聊而不是写文章。',
  '3. 如果你想说的上一条已经有人说过，或者现在真的没什么可补充的，只输出 ' + END_MARK + '，不要输出别的内容。',
  '4. 群聊里直接称呼对方的名字。',
].join('\n');

function homeDir() {
  const base = process.env.DSH_HOME || path.join(process.env.HOME || '.', '.dsh');
  return path.join(base, 'ai-group-chat');
}

function stateFile() {
  return path.join(homeDir(), 'state.json');
}

function loadGroups() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    const parsed = JSON.parse(raw);
    const groups = new Map();
    for (const g of parsed.groups || []) groups.set(g.id, normalizeGroup(g));
    return groups;
  } catch {
    return new Map();
  }
}

function saveGroups(groups) {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    version: 1,
    groups: [...groups.values()].map(g => {
      const clean = { ...g };
      delete clean.live;
      delete clean.lives;
      return clean;
    }),
  };
  const tmp = stateFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, stateFile());
}

function normalizeMember(m) {
  const member = {
    name: String(m.name),
    provider: String(m.provider),
    model: String(m.model),
  };
  if (m.effort !== undefined && m.effort !== null && m.effort !== '') member.effort = String(m.effort);
  if (typeof m.persona === 'string' && m.persona.trim()) member.persona = m.persona.trim();
  if (m.temperature !== undefined && m.temperature !== null && m.temperature !== '') {
    const t = Number(m.temperature);
    if (Number.isFinite(t) && t >= 0 && t <= 2) member.temperature = t;
  }
  if (m.maxTokens !== undefined && m.maxTokens !== null && m.maxTokens !== '') {
    const mt = Number(m.maxTokens);
    if (Number.isFinite(mt) && mt > 0) member.maxTokens = Math.floor(mt);
  }
  return member;
}

/* ---------- 实时推送（SSE） ---------- */

const subscribers = new Map();
/** 正在跑的群：groupId -> AbortController，供 /stop 中断。 */
const runningGroups = new Map();

function subscribeGroup(groupId, res) {
  let set = subscribers.get(groupId);
  if (!set) {
    set = new Set();
    subscribers.set(groupId, set);
  }
  set.add(res);
  return () => {
    const current = subscribers.get(groupId);
    if (!current) return;
    current.delete(res);
    if (current.size === 0) subscribers.delete(groupId);
  };
}

function broadcast(groupId, payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const key of [groupId, '*']) {
    const set = subscribers.get(key);
    if (!set || set.size === 0) continue;
    for (const res of set) {
      try {
        res.write(frame);
      } catch {
        set.delete(res);
      }
    }
  }
}

/** 把「谁正在干什么」推给所有窗口（思考内容/工具调用/发言中）。 */
function liveList(group) {
  return Object.values(group.lives || {})
    .filter(l => l && l.phase !== 'done')
    .map(l => ({
      speaker: l.speaker,
      phase: l.phase,
      toolName: l.toolName || '',
      reasoning: String(l.reasoning || '').slice(-6000),
      text: String(l.text || '').slice(-2000),
      at: l.at,
    }));
}

function broadcastLive(group) {
  broadcast(group.id, { type: 'live', groupId: group.id, lives: liveList(group) });
}

function maybeBroadcastLive(group, live) {
  const now = Date.now();
  if (now - (live._sent || 0) < 350) return;
  live._sent = now;
  broadcastLive(group);
}

/** 把一条消息推入历史：补 seq、广播给所有在看这个群的窗口。 */
function pushEntry(group, entry, added) {
  group.seq = Number(group.seq || 0) + 1;
  entry.seq = group.seq;
  group.history.push(entry);
  if (added) added.push(entry);
  broadcast(group.id, { type: 'message', groupId: group.id, entry });
  return entry;
}

/** 与 DSH 权限档位同名的三种模式。 */
const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'];

function normalizePermission(value) {
  if (value === false) return 'read-only';
  if (value === true || value === undefined || value === null || value === '') return 'danger-full-access';
  const mode = String(value);
  if (PERMISSION_MODES.includes(mode)) return mode;
  if (mode === 'none' || mode === 'read') return 'read-only';
  if (mode === 'all') return 'danger-full-access';
  return 'danger-full-access';
}

function normalizeGroup(g) {
  return {
    id: String(g.id),
    name: String(g.name ?? '未命名群聊'),
    members: Array.isArray(g.members) ? g.members.map(normalizeMember) : [],
    system: typeof g.system === 'string' ? g.system : '',
    permission: normalizePermission(g.permission ?? g.tools),
    cwd: typeof g.cwd === 'string' ? g.cwd : '',
    parallel: g.parallel === true,
    limits: {
      maxRounds: Number(g.limits?.maxRounds ?? 4),
      maxTokens: Number(g.limits?.maxTokens ?? 40000),
      maxMessages: Number(g.limits?.maxMessages ?? 60),
    },
    seq: Number(g.seq ?? 0),
    history: Array.isArray(g.history) ? g.history : [],
    usage: {
      tokens: Number(g.usage?.tokens ?? 0),
      calls: Number(g.usage?.calls ?? 0),
    },
    createdAt: g.createdAt ?? Date.now(),
  };
}

function newId() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function turnText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b && b.type === 'text').map(b => b.text).join('');
  }
  return '';
}

function buildPrompt(group, speaker) {
  const lines = group.history.map(m => {
    if (m.role === 'user') return `用户: ${m.text}`;
    return `${m.speaker}: ${m.text}`;
  });
  const others = group.members.filter(m => m.name !== speaker.name).map(m => m.name);
  const parts = [
    `群聊「${group.name}」目前的对话：`,
    lines.length > 0 ? lines.join('\n') : '（还没有人说话）',
    '',
    `现在轮到你（${speaker.name}）发言。群里还有：${others.join('、') || '（没有别人）'}。`,
  ];
  if (speaker.persona) {
    parts.push(`你的性格设定：${speaker.persona}。请始终按这个性格和口吻说话。`);
  }
  if (group.cwd) {
    parts.push(`本群的工作区是 ${group.cwd}。需要读写文件或执行命令时，请使用这个目录下的绝对路径。`);
  }
  if (group.permission === 'read-only') {
    parts.push('本群权限是「仅可查看」：只能读文件、搜索、抓网页，不能写文件、不能执行命令。');
  } else if (group.permission === 'workspace-write') {
    parts.push(`本群权限是「工作区内修改」：只能改动 ${group.cwd || '本群工作区'} 里的文件，越界会被拒绝。`);
  }
  parts.push(`直接输出你要说的话；如果确实没什么可说的，只输出 ${END_MARK}。`);
  return parts.join('\n');
}

/** 群聊自己注册的工具，不交给群员，否则会递归。 */
const SELF_TOOLS = new Set(['groupchat_manage', 'groupchat_talk']);
const MAX_TOOL_STEPS = 4;

/** 「只读」档允许的工具：不做任何写操作、不跑命令。 */
const READ_ONLY_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch',
  'session_search', 'session_event_read', 'session_event_search', 'session_event_trace', 'session_trace',
  'skill', 'todo_write', 'job_list', 'job_output', 'list_agents', 'list_subagent_models',
  'schedule_list', 'get_goal',
]);

function visibleSchemas(ctx, permission) {
  let all;
  try {
    all = ctx.tools.schemas().filter(t => t && !SELF_TOOLS.has(t.name));
  } catch {
    return [];
  }
  if (permission === 'read-only') return all.filter(t => READ_ONLY_TOOLS.has(t.name));
  return all;
}

/** workspace-write：参数里的路径必须落在群工作区内。返回错误串表示越界。 */
function guardWorkspaceWrite(group, name, args) {
  if (group.permission !== 'workspace-write') return null;
  if (!group.cwd) return null;
  const root = path.resolve(group.cwd);
  const candidates = [];
  for (const key of ['path', 'file_path', 'target', 'dest', 'destination']) {
    if (args && typeof args[key] === 'string' && args[key].trim()) candidates.push(args[key].trim());
  }
  for (const raw of candidates) {
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return `越界：${raw} 不在本群工作区 ${root} 内（当前权限：工作区内修改）`;
    }
  }
  return null;
}

function blockText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b && b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

/** 跑一个人的一次发言：收集文本、思考过程、工具调用与 token 用量。 */
async function speak(ctx, group, speaker, signal) {
  const system = group.system || DEFAULT_SYSTEM;
  const messages = [{ role: 'user', content: [{ type: 'text', text: buildPrompt(group, speaker) }] }];
  const schemas = visibleSchemas(ctx, group.permission);

  const live = {
    speaker: speaker.name,
    phase: 'thinking',
    toolName: '',
    reasoning: '',
    text: '',
    at: Date.now(),
  };
  group.lives = group.lives || {};
  group.lives[speaker.name] = live;
  group.usage.calls += 1;
  broadcastLive(group);

  let text = '';
  let reasoning = '';
  let tokens = 0;
  let failure;
  const toolCalls = [];
  const artifacts = [];

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const options = {
      provider: speaker.provider,
      model: speaker.model,
      messages,
      system,
      signal,
    };
    if (speaker.effort) options.reasoningEffort = speaker.effort;
    if (speaker.temperature !== undefined) options.temperature = speaker.temperature;
    if (speaker.maxTokens !== undefined) options.maxTokens = speaker.maxTokens;
    if (schemas.length > 0) options.tools = schemas;

    let stepText = '';
    let stepReasoning = '';
    const calls = [];

    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk.type === 'reasoning-delta') {
        stepReasoning += chunk.text;
        live.reasoning += chunk.text;
        live.phase = 'thinking';
        maybeBroadcastLive(group, live);
      } else if (chunk.type === 'text-delta') {
        stepText += chunk.text;
        live.text += chunk.text;
        live.phase = 'speaking';
        maybeBroadcastLive(group, live);
      }
      else if (chunk.type === 'block-end') {
        if (chunk.block && chunk.block.type === 'tool-call') calls.push(chunk.block);
      } else if (chunk.type === 'usage') {
        const u = chunk.usage;
        const delta = Number(u.totalTokens ?? (Number(u.inputTokens || 0) + Number(u.outputTokens || 0)));
        tokens += delta;
        group.usage.tokens += delta;
        broadcast(group.id, {
          type: 'usage',
          groupId: group.id,
          usage: { tokens: group.usage.tokens, calls: group.usage.calls },
          limits: group.limits,
        });
      } else if (chunk.type === 'finish') {
        if (chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          failure = chunk.reason.failure;
        }
      }
    }

    reasoning += stepReasoning;
    text += stepText;

    if (failure) break;
    if (calls.length === 0) break;

    // 把这一轮的 assistant 输出（含工具调用）回填进对话，再执行工具。
    const content = [];
    if (stepText.trim()) content.push({ type: 'text', text: stepText });
    for (const call of calls) {
      content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments });
    }
    messages.push({
      role: 'assistant',
      source: { kind: 'model', provider: speaker.provider, model: speaker.model },
      content,
    });

    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        args = {};
      }
      live.phase = 'tool';
      live.toolName = call.name;
      broadcastLive(group);
      let resultText = '';
      let isError = false;
      const blocked = guardWorkspaceWrite(group, call.name, args);
      if (blocked) {
        isError = true;
        resultText = blocked;
        toolCalls.push({ name: call.name, args, result: resultText, isError });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          source: { kind: 'tool', callId: call.id },
          content: [{ type: 'text', text: resultText }],
          isError: true,
        });
        continue;
      }
      try {
        const result = await ctx.tools.execute({
          callId: call.id,
          name: call.name,
          arguments: args,
          signal,
        });
        isError = !!result.isError;
        resultText = blockText(result.content);
        if (!resultText) {
          resultText = isError
            ? `（工具返回错误：${result.error && result.error.message ? result.error.message : '未知'}）`
            : JSON.stringify(result.value ?? null).slice(0, 4000);
        }
      } catch (err) {
        isError = true;
        resultText = `工具执行失败：${err && err.message ? err.message : String(err)}`;
      }
      toolCalls.push({
        name: call.name,
        args,
        result: resultText.slice(0, 4000),
        isError,
      });
      if (!isError) {
        const candidates = new Set();
        for (const key of ['path', 'file_path', 'target', 'output_path', 'dest', 'destination']) {
          const v = args && args[key];
          if (typeof v === 'string' && v.trim()) candidates.add(v.trim());
        }
        // bash 里的重定向 / tee 目标也算产物
        if (args && typeof args.command === 'string') {
          const re = /(?:>>?|tee\s+(?:-a\s+)?)\s*["']?([^\s"'|;&]+)["']?/g;
          let m;
          while ((m = re.exec(args.command)) !== null) {
            if (m[1] && m[1] !== '/dev/null') candidates.add(m[1]);
          }
        }
        for (const raw of candidates) {
          const resolved = path.isAbsolute(raw)
            ? raw
            : group.cwd
              ? path.resolve(group.cwd, raw)
              : null;
          if (!resolved) continue;
          let ok = false;
          try {
            ok = fs.statSync(resolved).isFile();
          } catch {
            ok = false;
          }
          if (ok && !artifacts.some(a => a.path === resolved)) {
            artifacts.push({ path: resolved, tool: call.name });
          }
        }
      }
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        source: { kind: 'tool', callId: call.id },
        content: [{ type: 'text', text: resultText.slice(0, 12000) }],
        ...(isError ? { isError: true } : {}),
      });
      live.phase = 'thinking';
      live.toolName = '';
      broadcastLive(group);
    }

    // 执行完工具就清空 text，避免把中间轮的旁白当成最终发言。
    text = '';
  }

  live.phase = 'done';
  broadcastLive(group);
  return { text: text.trim(), reasoning: reasoning.trim(), toolCalls, artifacts, tokens, failure };
}

/** 让群聊推进若干轮。 */
/** 把一次发言的结果落成群聊条目，返回 'ok' | 'settled' | 'error'。 */
function finishTurn(group, member, result, added) {
  if (result.failure) {
    const entry = { role: 'system-note', speaker: member.name, text: `（${member.name} 出错：${result.failure.message}）`, at: Date.now() };
    pushEntry(group, entry, added);
    return 'error';
  }
  const body = result.text || '';
  if (body === '' || body.includes(END_MARK)) {
    const entry = { role: 'system-note', speaker: member.name, text: `（${member.name} 没什么要补充的了）`, at: Date.now() };
    pushEntry(group, entry, added);
    return 'settled';
  }
  const entry = { role: 'assistant', speaker: member.name, text: body, at: Date.now() };
  if (result.reasoning) entry.reasoning = result.reasoning;
  if (result.toolCalls && result.toolCalls.length > 0) entry.toolCalls = result.toolCalls;
  if (result.artifacts && result.artifacts.length > 0) entry.artifacts = result.artifacts;
  pushEntry(group, entry, added);
  return 'ok';
}

async function runTurns(ctx, group, rounds, seedMessage, signal) {
  const added = [];
  group.running = true;
  group.lives = {};
  broadcast(group.id, { type: 'status', groupId: group.id, phase: 'running', running: true });
  if (seedMessage) {
    const entry = { role: 'user', text: seedMessage, at: Date.now() };
    pushEntry(group, entry, added);
  }

  const members = group.members;
  if (members.length === 0) return { added, stoppedBy: 'empty' };

  let stoppedBy = 'rounds';
  let round = 0;

  outer: while (round < rounds) {
    round += 1;
    if (group.parallel && members.length > 1) {
      const snapshot = group.history.slice();
      let anySettled = false;
      const settled = await Promise.all(
        members.map(async member => {
          const view = { ...group, history: snapshot };
          try {
            return { member, result: await speak(ctx, view, member, signal) };
          } catch (error) {
            return { member, error };
          }
        }),
      );
      for (const item of settled) {
        if (item.error) {
          const entry = {
            role: 'system-note',
            speaker: item.member.name,
            text: `（${item.member.name} 调用失败：${item.error?.message || item.error}）`,
            at: Date.now(),
          };
          pushEntry(group, entry, added);
          if (group.lives && group.lives[item.member.name]) group.lives[item.member.name].phase = 'done';
          continue;
        }
        if (finishTurn(group, item.member, item.result, added) === 'settled') anySettled = true;
      }
      broadcast(group.id, { type: 'status', groupId: group.id, phase: 'idle' });
      if (anySettled) { stoppedBy = 'settled'; break outer; }
      continue;
    }

    for (const member of members) {
      if (group.usage.tokens >= group.limits.maxTokens) { stoppedBy = 'token-limit'; break outer; }
      if (group.history.length >= group.limits.maxMessages) { stoppedBy = 'message-limit'; break outer; }
      if (signal?.aborted) { stoppedBy = 'aborted'; break outer; }

      broadcast(group.id, {
        type: 'status',
        groupId: group.id,
        phase: 'thinking',
        speaker: member.name,
        speakerModel: member.model,
        round,
      });

      let result;
      try {
        result = await speak(ctx, group, member, signal);
      } catch (error) {
        const entry = { role: 'system-note', speaker: member.name, text: `（${member.name} 调用失败：${error?.message || error}）`, at: Date.now() };
        pushEntry(group, entry, added);
        if (group.lives && group.lives[member.name]) group.lives[member.name].phase = 'done';
        broadcast(group.id, { type: 'status', groupId: group.id, phase: 'idle' });
        continue;
      }

      broadcast(group.id, { type: 'status', groupId: group.id, phase: 'idle', speaker: member.name });


      const outcome = finishTurn(group, member, result, added);
      if (outcome === 'settled') {
        stoppedBy = 'settled';
        break outer;
      }
    }
  }

  group.running = false;
  group.lives = {};
  broadcastLive(group);
  broadcast(group.id, { type: 'status', groupId: group.id, phase: 'idle', running: false });
  return { added, stoppedBy };
}

function textOutput(description) {
  return {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: 'text', text: String(value?.text ?? '') }];
    },
  };
}

function summarize(group) {
  return {
    id: group.id,
    name: group.name,
    members: group.members.map(m => ({
      name: m.name,
      provider: m.provider,
      model: m.model,
      ...(m.effort ? { effort: m.effort } : {}),
      ...(m.persona ? { persona: m.persona } : {}),
      ...(m.temperature !== undefined ? { temperature: m.temperature } : {}),
      ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
    })),
    limits: group.limits,
    permission: group.permission,
    parallel: !!group.parallel,
    cwd: group.cwd || '',
    running: !!group.running,
    usage: group.usage,
    messages: group.history.length,
    createdAt: group.createdAt,
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** SSE：群聊消息实时推送。 */
function handleEvents(req, res, reqUrl) {
  const groupId = String(reqUrl.searchParams.get('group') || '');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const unsubscribe = subscribeGroup(groupId, res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* 连接已断，等 close 清理 */
    }
  }, 25000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

/** Client 面板用的 HTTP 接口。 */
async function handleApi(ctx, groups, req, res) {
  const reqUrl = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && reqUrl.pathname.endsWith('/events')) {
    handleEvents(req, res, reqUrl);
    return;
  }
  const body = req.method === 'POST' ? await readBody(req) : {};
  const action = String(body.action || 'list');

  try {
    if (action === 'models') {
      const providers = ctx.llm.listProviders();
      const groupsOut = [];
      for (const p of providers) {
        let models = [];
        try {
          models = await ctx.llm.listModels(p.id);
        } catch {
          models = [];
        }
        groupsOut.push({
          provider: p.id,
          name: p.name,
          models: models.map(m => ({ id: m.id, name: m.name })),
        });
      }
      sendJson(res, 200, { ok: true, providers: groupsOut });
      return;
    }

    if (action === 'efforts') {
      const provider = String(body.provider || '');
      const model = String(body.model || '');
      let efforts = [];
      let defaultEffort = null;
      try {
        const info = await ctx.llm.resolveModelInfo(provider, model);
        const reasoning = info && info.reasoning;
        if (reasoning) {
          efforts = (reasoning.efforts || []).map(e => ({ id: String(e.id), name: String(e.name) }));
          if (reasoning.defaultEffort) defaultEffort = String(reasoning.defaultEffort);
        }
      } catch (error) {
        sendJson(res, 200, { ok: true, efforts: [], defaultEffort: null, error: error?.message || String(error) });
        return;
      }
      sendJson(res, 200, { ok: true, efforts, defaultEffort });
      return;
    }

    if (action === 'file') {
      const group = groups.get(String(body.id));
      if (!group) {
        sendJson(res, 404, { ok: false, error: '找不到这个群聊' });
        return;
      }
      const rawPath = String(body.path || '').trim();
      if (!rawPath) {
        sendJson(res, 400, { ok: false, error: '没有给文件路径' });
        return;
      }
      let target;
      if (group.cwd) {
        const root = path.resolve(group.cwd);
        target = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, rawPath);
        if (target !== root && !target.startsWith(root + path.sep)) {
          sendJson(res, 403, { ok: false, error: '只能查看群工作区里的文件' });
          return;
        }
      } else {
        if (!path.isAbsolute(rawPath)) {
          sendJson(res, 400, {
            ok: false,
            error: '这个群没设工作区，只能用绝对路径查看文件',
          });
          return;
        }
        target = path.resolve(rawPath);
      }
      try {
        const stat = fs.statSync(target);
        if (!stat.isFile()) {
          sendJson(res, 400, { ok: false, error: '不是一个文件' });
          return;
        }
        const text = fs.readFileSync(target, 'utf8').slice(0, 200000);
        sendJson(res, 200, { ok: true, path: target, bytes: stat.size, text });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message || error) });
      }
      return;
    }

    if (action === 'list') {
      sendJson(res, 200, { ok: true, groups: [...groups.values()].map(g => ({
        ...summarize(g),
        lives: liveList(g),
        history: g.history.slice(-60),
      })) });
      return;
    }

    if (action === 'create') {
      const members = Array.isArray(body.members) ? body.members : [];
      if (members.length === 0) {
        sendJson(res, 400, { ok: false, error: '至少选一个成员' });
        return;
      }
      const group = normalizeGroup({
        id: newId(),
        name: body.name || '未命名群聊',
        members: members.map((m, i) => ({
          name: String(m.name || m.model || `成员${i + 1}`),
          provider: String(m.provider),
          model: String(m.model),
          effort: m.effort,
          persona: m.persona,
          temperature: m.temperature,
          maxTokens: m.maxTokens,
        })),
        system: body.system || '',
        permission: body.permission ?? body.tools,
        cwd: body.cwd,
        parallel: body.parallel,
        limits: {
          maxRounds: body.maxRounds ?? 4,
          maxTokens: body.maxTokens ?? 40000,
          maxMessages: body.maxMessages ?? 60,
        },
      });
      groups.set(group.id, group);
      saveGroups(groups);
      sendJson(res, 200, { ok: true, group: summarize(group) });
      return;
    }

    if (action === 'delete') {
      const group = groups.get(String(body.id));
      if (!group) {
        sendJson(res, 404, { ok: false, error: '找不到这个群聊' });
        return;
      }
      groups.delete(group.id);
      saveGroups(groups);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (action === 'update') {
      const group = groups.get(String(body.id));
      if (!group) {
        sendJson(res, 404, { ok: false, error: '找不到这个群聊' });
        return;
      }
      if (body.name) group.name = String(body.name);
      if (body.system !== undefined) group.system = String(body.system);
      if (body.permission !== undefined || body.tools !== undefined) {
        group.permission = normalizePermission(body.permission ?? body.tools);
      }
      if (body.cwd !== undefined) group.cwd = String(body.cwd);
      if (body.parallel !== undefined) group.parallel = body.parallel === true;
      if (Array.isArray(body.members)) {
        if (body.members.length === 0) {
          sendJson(res, 400, { ok: false, error: '至少要留一个成员' });
          return;
        }
        const next = [];
        for (let i = 0; i < body.members.length; i++) {
          const raw = body.members[i] || {};
          if (!raw.provider || !raw.model) {
            sendJson(res, 400, { ok: false, error: `第 ${i + 1} 个成员没有选模型` });
            return;
          }
          next.push(
            normalizeMember({
              name: raw.name || raw.model,
              provider: raw.provider,
              model: raw.model,
              effort: raw.effort,
              persona: raw.persona,
              temperature: raw.temperature,
              maxTokens: raw.maxTokens,
            }),
          );
        }
        group.members = next;
      }
      if (body.maxRounds !== undefined) group.limits.maxRounds = Number(body.maxRounds);
      if (body.maxTokens !== undefined) group.limits.maxTokens = Number(body.maxTokens);
      if (body.maxMessages !== undefined) group.limits.maxMessages = Number(body.maxMessages);
      saveGroups(groups);
      broadcast(group.id, { type: 'updated', groupId: group.id, group: summarize(group) });
      sendJson(res, 200, { ok: true, group: summarize(group) });
      return;
    }

    if (action === 'stop') {
      const group = groups.get(String(body.id));
      if (!group) {
        sendJson(res, 404, { ok: false, error: '找不到这个群聊' });
        return;
      }
      const controller = runningGroups.get(group.id);
      if (!controller) {
        sendJson(res, 200, { ok: true, stopped: false, note: '这个群当前没有在跑' });
        return;
      }
      controller.abort();
      sendJson(res, 200, { ok: true, stopped: true });
      return;
    }

    if (action === 'talk') {
      const group = groups.get(String(body.id));
      if (!group) {
        sendJson(res, 404, { ok: false, error: '找不到这个群聊' });
        return;
      }
      if (group.members.length === 0) {
        sendJson(res, 400, { ok: false, error: '这个群还没有成员' });
        return;
      }
      const rounds = Math.max(1, Math.min(Number(body.rounds ?? group.limits.maxRounds), 20));
      const controller = new AbortController();
      runningGroups.set(group.id, controller);
      let result;
      try {
        result = await runTurns(ctx, group, rounds, body.message ? String(body.message) : '', controller.signal);
      } finally {
        runningGroups.delete(group.id);
      }
      saveGroups(groups);
      broadcast(group.id, { type: 'done', groupId: group.id, usage: group.usage, limits: group.limits, stoppedBy: result.stoppedBy });
      sendJson(res, 200, {
        ok: true,
        added: result.added,
        stoppedBy: result.stoppedBy,
        usage: group.usage,
        limits: group.limits,
      });
      return;
    }

    sendJson(res, 400, { ok: false, error: `未知 action: ${action}` });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message || error) });
  }
}

export function apply(ctx) {
  const groups = loadGroups();

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/ai-group-chat/api',
      handler: (req, res) => handleApi(ctx, groups, req, res),
    }),
    'ai-group-chat: http api',
  );

  const manage = {
    name: 'groupchat_manage',
    description:
      '管理 AI 群聊。action=create 建群（name、members 必填，members 每项 {name, provider, model}）；' +
      'action=list 列出所有群；action=update 改名字/成员/上限；action=delete 删群；' +
      'action=show 看某个群的最近对话。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'delete', 'show'] },
        id: { type: 'string', description: '群 id（update/delete/show 必填）' },
        name: { type: 'string', description: '群名' },
        members: {
          type: 'array',
          description: '成员列表，每项 { name, provider, model, effort? }。name 是群里的称呼。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              effort: { type: 'string' },
              persona: { type: 'string', description: '这个成员的性格/人设，比如“毒舌但严谨，爱抬杠”' },
              temperature: { type: 'number', description: '0-2，越大多样性越高；不填用模型默认' },
              maxTokens: { type: 'number', description: '单次发言最大输出 token；不填用模型默认' },
            },
            required: ['name', 'provider', 'model'],
          },
        },
        system: { type: 'string', description: '群规/系统提示，留空用默认规则' },
        maxRounds: { type: 'number', description: '最多几轮（每轮每人说一次）' },
        maxTokens: { type: 'number', description: '整个群累计 token 上限' },
        maxMessages: { type: 'number', description: '历史消息条数上限' },
      },
      required: ['action'],
    },
    output: textOutput(),
    async execute(args) {
      const action = String(args.action || '');

      if (action === 'list') {
        if (groups.size === 0) return { text: '还没有群聊。用 action=create 建一个。' };
        const text = [...groups.values()].map(g => {
          const names = g.members.map(m => `${m.name}(${m.provider}/${m.model})`).join('、');
          return `- ${g.id} 「${g.name}」 成员：${names || '（空）'} ｜ ${g.history.length} 条消息，已用 ${g.usage.tokens}/${g.limits.maxTokens} tokens`;
        }).join('\n');
        return { text };
      }

      if (action === 'create') {
        const members = Array.isArray(args.members) ? args.members : [];
        if (members.length === 0) return { text: '建群至少要有一个成员（members）。' };
        const group = normalizeGroup({
          id: newId(),
          name: args.name || '未命名群聊',
          members: members.map((m, i) => ({
            name: String(m.name || m.model || `成员${i + 1}`),
            provider: String(m.provider),
            model: String(m.model),
            effort: m.effort,
            persona: m.persona,
            temperature: m.temperature,
            maxTokens: m.maxTokens,
          })),
          system: args.system || '',
          limits: {
            maxRounds: args.maxRounds ?? 4,
            maxTokens: args.maxTokens ?? 40000,
            maxMessages: args.maxMessages ?? 60,
          },
        });
        groups.set(group.id, group);
        saveGroups(groups);
        return { text: `群聊已创建：${group.id}「${group.name}」，成员 ${group.members.map(m => m.name).join('、')}。` };
      }

      const group = args.id ? groups.get(String(args.id)) : undefined;
      if (action !== 'create' && action !== 'list' && !group) {
        return { text: `找不到群聊 ${args.id}。用 action=list 看现有群。` };
      }

      if (action === 'delete') {
        groups.delete(group.id);
        saveGroups(groups);
        return { text: `已删除群聊「${group.name}」（${group.id}）。` };
      }

      if (action === 'update') {
        if (args.name) group.name = String(args.name);
        if (args.system !== undefined) group.system = String(args.system);
        if (Array.isArray(args.members) && args.members.length > 0) {
          group.members = args.members.map((m, i) => ({
            name: String(m.name || m.model || `成员${i + 1}`),
            provider: String(m.provider),
            model: String(m.model),
            effort: m.effort,
            persona: m.persona,
            temperature: m.temperature,
            maxTokens: m.maxTokens,
          }));
        }
        if (args.maxRounds !== undefined) group.limits.maxRounds = Number(args.maxRounds);
        if (args.maxTokens !== undefined) group.limits.maxTokens = Number(args.maxTokens);
        if (args.maxMessages !== undefined) group.limits.maxMessages = Number(args.maxMessages);
        saveGroups(groups);
        return { text: `已更新「${group.name}」：${JSON.stringify(summarize(group))}` };
      }

      if (action === 'show') {
        if (group.history.length === 0) return { text: `「${group.name}」还没有任何对话。` };
        const text = group.history.slice(-40).map(m => {
          if (m.role === 'user') return `用户: ${m.text}`;
          if (m.role === 'system-note') return m.text;
          return `${m.speaker}: ${m.text}`;
        }).join('\n');
        return { text: `${group.name}（${group.usage.tokens}/${group.limits.maxTokens} tokens）\n\n${text}` };
      }

      return { text: `未知 action：${action}` };
    },
  };

  const talk = {
    name: 'groupchat_talk',
    description:
      '让 AI 群聊继续说话。message 是你（人类/主代理）发到群里的话；省略则让它们自己接着聊。' +
      '会自动轮转成员发言，直到达到轮次/ token 上限，或者所有成员都觉得没什么可说的。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '群 id' },
        message: { type: 'string', description: '你要发到群里的话（可选）' },
        rounds: { type: 'number', description: '这次最多跑几轮，默认用群的 maxRounds' },
      },
      required: ['id'],
    },
    output: textOutput(),
    timeoutMs: 600000,
    async execute(args, exec) {
      const group = groups.get(String(args.id));
      if (!group) return { text: `找不到群聊 ${args.id}。` };
      if (group.members.length === 0) return { text: `「${group.name}」没有成员。` };

      const rounds = Math.max(1, Math.min(Number(args.rounds ?? group.limits.maxRounds), 20));
      const controller = new AbortController();
      const upstream = exec?.signal;
      if (upstream) {
        if (upstream.aborted) controller.abort();
        else upstream.addEventListener('abort', () => controller.abort(), { once: true });
      }
      runningGroups.set(group.id, controller);
      let result;
      try {
        result = await runTurns(ctx, group, rounds, args.message ? String(args.message) : '', controller.signal);
      } finally {
        runningGroups.delete(group.id);
      }
      saveGroups(groups);
      broadcast(group.id, { type: 'done', groupId: group.id, usage: group.usage, limits: group.limits, stoppedBy: result.stoppedBy });

      const lines = result.added.map(m => {
        if (m.role === 'user') return `用户: ${m.text}`;
        if (m.role === 'system-note') return m.text;
        return `${m.speaker}: ${m.text}`;
      });
      const reason = {
        settled: '所有成员都觉得没什么可说的了',
        'token-limit': '达到 token 上限',
        'message-limit': '达到消息条数上限',
        rounds: '跑完轮次',
        aborted: '被中止',
        empty: '群里没有成员',
      }[result.stoppedBy] || result.stoppedBy;

      return {
        text: [
          `「${group.name}」本轮新增 ${result.added.length} 条，停止原因：${reason}。`,
          `累计用量：${group.usage.tokens}/${group.limits.maxTokens} tokens，${group.usage.calls} 次调用。`,
          '',
          ...lines,
        ].join('\n'),
      };
    },
  };

  ctx.effect(() => ctx.tools.register(manage), 'ai-group-chat: manage tool');
  ctx.effect(() => ctx.tools.register(talk), 'ai-group-chat: talk tool');
}
