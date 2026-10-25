// AI 群聊 —— Client half.
// 侧边栏图标 + 主面板。数据全部走同源 HTTP /ai-group-chat/api。

window.__ModuleLoader__.load({
  id: 'dsh-ai-group-chat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const API = '/ai-group-chat/api';

    function authHeaders() {
      const headers = { 'content-type': 'application/json' };
      try {
        const token = new URLSearchParams(window.location.search).get('token');
        if (token) headers.authorization = 'Bearer ' + token;
      } catch {}
      return headers;
    }

    async function api(action, payload) {
      const response = await fetch(API, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ action, ...(payload || {}) }),
      });
      let json;
      try {
        json = await response.json();
      } catch {
        json = { ok: false, error: 'HTTP ' + response.status };
      }
      if (!response.ok && !json.error) json.error = 'HTTP ' + response.status;
      return json;
    }

    function mergeEntries(list, entries) {
      const have = new Set();
      for (const m of list) if (m && m.seq !== undefined) have.add(m.seq);
      const out = list.slice();
      for (const m of entries || []) {
        if (!m) continue;
        if (m.seq !== undefined && have.has(m.seq)) continue;
        if (m.seq !== undefined) have.add(m.seq);
        out.push(m);
      }
      return out;
    }

    const surface = 'var(--dsw-alias-bg-layer-1)';
    const base = 'var(--dsw-alias-bg-base)';
    const ink = 'var(--dsw-alias-label-primary)';
    const dim = 'var(--dsw-alias-label-secondary)';
    const line = 'var(--dsw-alias-border-l1)';
    const brand = 'var(--dsw-alias-brand-primary)';
    const danger = 'var(--dsw-alias-state-error-primary)';

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: base,
        color: ink,
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 14px',
        borderBottom: '1px solid ' + line,
        flexShrink: 0,
      },
      title: { fontSize: 15, fontWeight: 600, flex: 1 },
      body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 },
      card: {
        border: '1px solid ' + line,
        borderRadius: 12,
        background: surface,
        padding: 12,
        marginBottom: 10,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      button: {
        border: '1px solid ' + line,
        background: surface,
        color: ink,
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 13,
        cursor: 'pointer',
      },
      primary: {
        border: '1px solid transparent',
        background: brand,
        color: '#fff',
        borderRadius: 8,
        padding: '6px 14px',
        fontSize: 13,
        cursor: 'pointer',
      },
      ghost: {
        border: 'none',
        background: 'transparent',
        color: dim,
        fontSize: 12,
        cursor: 'pointer',
        padding: 4,
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid ' + line,
        borderRadius: 8,
        background: base,
        color: ink,
        padding: '8px 10px',
        fontSize: 14,
        fontFamily: 'inherit',
      },
      meta: { fontSize: 12, color: dim, marginTop: 4 },
      bubble: {
        padding: '8px 10px',
        borderRadius: 10,
        background: surface,
        border: '1px solid ' + line,
        marginBottom: 8,
        fontSize: 14,
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      speaker: { fontSize: 12, color: brand, fontWeight: 600, marginBottom: 2 },
      note: { fontSize: 12, color: dim, fontStyle: 'italic', marginBottom: 8 },
      err: { fontSize: 12, color: danger, marginTop: 8, whiteSpace: 'pre-wrap' },
      section: { fontSize: 12, color: dim, margin: '14px 0 6px' },
      chip: {
        display: 'inline-block',
        border: '1px solid ' + line,
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 12,
        marginRight: 6,
        marginBottom: 4,
      },
      toolCard: {
        border: '1px solid ' + line,
        borderRadius: 8,
        padding: '3px 8px',
        margin: '4px 0',
        background: base,
      },
      toolTitle: { fontSize: 12, color: dim, cursor: 'pointer' },
      toolBody: {
        fontSize: 11,
        color: dim,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxHeight: 220,
        overflowY: 'auto',
        margin: '4px 0 2px',
      },
      thought: {
        fontSize: 12,
        color: dim,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 260,
        overflowY: 'auto',
        margin: '2px 0 6px',
      },
      effortSelect: {
        fontSize: 12,
        color: ink,
        background: base,
        border: '1px solid ' + line,
        borderRadius: 6,
        padding: '1px 4px',
        marginLeft: 6,
      },
    };

    /** 侧边栏图标。 */
    function GroupIcon(props) {
      const size = (props && props.size) || 20;
      const active = !!(props && props.active);
      const [running, setRunning] = useState(false);

      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.EventSource !== 'function') return undefined;
        const source = new window.EventSource(API + '/events?group=*');
        source.onmessage = event => {
          let data;
          try {
            data = JSON.parse(event.data);
          } catch {
            return;
          }
          if (!data || data.type !== 'status') return;
          if (data.phase === 'thinking' || data.phase === 'running') setRunning(true);
          else if (data.phase === 'idle' && data.running === false) setRunning(false);
        };
        return () => source.close();
      }, []);
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 64 64',
          fill: 'none',
          style: { opacity: active ? 1 : 0.75 },
        },
        h('rect', {
          x: 2,
          y: 2,
          width: 60,
          height: 60,
          rx: 16,
          fill: 'url(#agc-g)',
        }),
        h('circle', { cx: 21, cy: 24, r: 7, fill: '#fff', opacity: 0.95 }),
        h('circle', { cx: 43, cy: 24, r: 7, fill: '#fff', opacity: 0.95 }),
        h('circle', { cx: 32, cy: 40, r: 8, fill: '#fff', opacity: 0.95 }),
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: 'agc-g', x1: '0', y1: '0', x2: '64', y2: '64' },
            h('stop', { stopColor: '#6f7bff' }),
            h('stop', { offset: '1', stopColor: '#b26bff' }),
          ),
        ),
        running
          ? h('circle', { cx: 54, cy: 10, r: 7, fill: '#3ddc84', stroke: '#fff', strokeWidth: 2 })
          : null,
      );
    }

    function ChatView(props) {
      const group = props.group;
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [messages, setMessages] = useState(group.history || []);
      const [usage, setUsage] = useState(group.usage || { tokens: 0, calls: 0 });
      const [status, setStatus] = useState({ phase: 'idle', speaker: '' });
      const [lives, setLives] = useState(Array.isArray(group.lives) ? group.lives : []);
      const [artifact, setArtifact] = useState(null);

      const openArtifact = useCallback(
        async rawPath => {
          const result = await api('file', { id: group.id, path: rawPath });
          setArtifact(
            result.ok
              ? { path: result.path || rawPath, text: result.text || '' }
              : { path: rawPath, error: result.error || '读不出来' },
          );
        },
        [group.id],
      );
      const bottomRef = useRef(null);

      useEffect(() => {
        if (bottomRef.current && bottomRef.current.scrollIntoView) {
          bottomRef.current.scrollIntoView({ block: 'end' });
        }
      }, [messages.length]);

      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.EventSource !== 'function') return undefined;
        const source = new window.EventSource(API + '/events?group=' + encodeURIComponent(group.id));
        source.onmessage = event => {
          let data;
          try {
            data = JSON.parse(event.data);
          } catch {
            return;
          }
          if (!data || data.groupId !== group.id) return;
          if (data.type === 'message' && data.entry) {
            setMessages(list => mergeEntries(list, [data.entry]));
          } else if (data.type === 'live') {
            setLives(Array.isArray(data.lives) ? data.lives : []);
            if (Array.isArray(data.lives) && data.lives.length > 0) setBusy(true);
          } else if (data.type === 'usage') {
            if (data.usage) setUsage(data.usage);
          } else if (data.type === 'status') {
            if (data.phase === 'thinking') {
              setStatus({ phase: 'thinking', speaker: data.speaker || '' });
              setBusy(true);
            } else if (data.phase === 'running') {
              if (data.running) setBusy(true);
            } else {
              setStatus({ phase: 'idle', speaker: data.speaker || '' });
              if (data.running === false) setBusy(false);
            }
          } else if (data.type === 'done') {
            if (data.usage) setUsage(data.usage);
            setBusy(false);
            setStatus({ phase: 'idle', speaker: '' });
          }
        };
        return () => source.close();
      }, [group.id]);

      const stopRun = useCallback(async () => {
        await api('stop', { id: group.id });
      }, [group.id]);

      const send = useCallback(
        async text => {
          if (busy) return;
          setBusy(true);
          setError('');
          const result = await api('talk', { id: group.id, message: text, rounds: group.limits.maxRounds });
          setBusy(false);
          if (!result.ok) {
            setError(result.error || '调用失败');
            return;
          }
          setMessages(list => mergeEntries(list, result.added));
          if (result.usage) setUsage(result.usage);
          setDraft('');
        },
        [busy, group.id, group.limits.maxRounds],
      );

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        h(
          'div',
          { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 } },
          messages.length === 0
            ? h('div', { style: styles.note }, '还没有对话。发一句话，让他们开始。')
            : messages.map((m, i) => {
                if (m.role === 'system-note') {
                  return h('div', { key: i, style: styles.note }, m.text);
                }
                if (m.role === 'user') {
                  return h(
                    'div',
                    { key: i, style: styles.bubble },
                    h('div', { style: { ...styles.speaker, color: dim } }, '你'),
                    m.text,
                  );
                }
                const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
                return h(
                  'div',
                  { key: i, style: styles.bubble },
                  h('div', { style: styles.speaker }, m.speaker),
                  m.reasoning
                    ? h(
                        'details',
                        { style: { margin: '2px 0 6px' } },
                        h('summary', { style: styles.toolTitle }, '思考过程'),
                        h('div', { style: styles.thought }, m.reasoning),
                      )
                    : null,
                  toolCalls.length > 0
                    ? h(
                        'div',
                        { style: { margin: '2px 0 4px' } },
                        toolCalls.map((tool, k) =>
                          h(
                            'details',
                            { key: k, style: styles.toolCard },
                            h(
                              'summary',
                              { style: styles.toolTitle },
                              `${tool.isError ? '⚠ ' : '🔧 '}调用 ${tool.name}`,
                            ),
                            h(
                              'pre',
                              { style: styles.toolBody },
                              `${JSON.stringify(tool.args ?? {}, null, 2)}\n\n${tool.result ?? ''}`,
                            ),
                            (() => {
                              const candidate =
                                tool.args && (tool.args.path || tool.args.file_path || tool.args.target);
                              if (!candidate || typeof candidate !== 'string') return null;
                              return h(
                                'button',
                                {
                                  style: { ...styles.ghost, marginTop: 2 },
                                  onClick: () => openArtifact(candidate),
                                },
                                '查看产物',
                              );
                            })(),
                          ),
                        ),
                      )
                    : null,
                  m.text,
                  Array.isArray(m.artifacts) && m.artifacts.length > 0
                    ? h(
                        'div',
                        {
                          style: {
                            marginTop: 8,
                            paddingTop: 6,
                            borderTop: '1px solid ' + line,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                          },
                        },
                        h('div', { style: { fontSize: 11, color: dim } }, '交付的文件'),
                        m.artifacts.map((a, k) =>
                          h(
                            'button',
                            {
                              key: k,
                              style: {
                                ...styles.chip,
                                cursor: 'pointer',
                                textAlign: 'left',
                                fontFamily: 'inherit',
                                whiteSpace: 'normal',
                                wordBreak: 'break-all',
                              },
                              onClick: () => openArtifact(a.path),
                            },
                            '\u{1F4C4} ' + String(a.path).split('/').pop(),
                          ),
                        ),
                      )
                    : null,
                );
              }),
          lives.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, marginBottom: 8 } },
                lives.map((live, k) =>
                  h(
                    'div',
                    {
                      key: k,
                      style: {
                        border: '1px solid ' + brand,
                        borderRadius: 10,
                        padding: '6px 10px',
                        background: surface,
                      },
                    },
                    h(
                      'details',
                      null,
                      h(
                        'summary',
                        { style: { fontSize: 12, color: brand, cursor: 'pointer' } },
                        live.phase === 'tool'
                          ? `${live.speaker} 正在调用 ${live.toolName || '工具'}`
                          : live.phase === 'speaking'
                            ? `${live.speaker} 正在回复…`
                            : `${live.speaker} 正在思考…`,
                      ),
                      h(
                        'div',
                        { style: { ...styles.thought, marginTop: 6 } },
                        live.reasoning ? live.reasoning : '（还没有思考内容）',
                      ),
                      live.text
                        ? h(
                            'div',
                            {
                              style: {
                                ...styles.thought,
                                color: ink,
                                marginTop: 6,
                                paddingTop: 6,
                                borderTop: '1px solid ' + line,
                              },
                            },
                            live.text,
                          )
                        : null,
                    ),
                  ),
                ),
              )
            : status.phase === 'thinking'
              ? h(
                  'div',
                  { style: { ...styles.note, color: brand, marginTop: 4 } },
                  `${status.speaker || '有成员'} 正在思考…`,
                )
              : null,
          h('div', { ref: bottomRef }),
        ),
        error ? h('div', { style: { ...styles.err, padding: '0 14px' } }, error) : null,
        h(
          'div',
          { style: { padding: 12, borderTop: '1px solid ' + line, flexShrink: 0 } },
          h(
            'div',
            { style: styles.row },
            h('input', {
              style: styles.input,
              value: draft,
              placeholder: busy ? '他们正在说…' : '说点什么，或直接点「让他们聊」',
              disabled: busy,
              onChange: event => setDraft(event.target.value),
              onKeyDown: event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send(draft.trim());
                }
              },
            }),
            h(
              'button',
              {
                style: busy
                  ? { ...styles.button, borderColor: danger, color: danger }
                  : styles.primary,
                onClick: () => (busy ? stopRun() : send(draft.trim())),
              },
              busy ? '■ 停止' : '发送',
            ),
          ),
          h(
            'div',
            { style: { ...styles.meta, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('span', null, `${usage.tokens}/${group.limits.maxTokens} tokens · ${usage.calls} 次调用`),
            h(
              'button',
              { style: styles.ghost, disabled: busy, onClick: () => send('') },
              '让他们自己聊 →',
            ),
          ),
        ),
        artifact
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(0,0,0,0.55)',
                  zIndex: 9999,
                  display: 'flex',
                  flexDirection: 'column',
                  padding: 16,
                },
              },
              h(
                'div',
                {
                  style: {
                    background: base,
                    borderRadius: 12,
                    padding: 12,
                    flex: 1,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    border: '1px solid ' + line,
                  },
                },
                h(
                  'div',
                  { style: { ...styles.row, marginBottom: 8, flexShrink: 0 } },
                  h(
                    'div',
                    { style: { flex: 1, fontSize: 12, color: dim, wordBreak: 'break-all' } },
                    artifact.path,
                  ),
                  h('button', { style: styles.ghost, onClick: () => setArtifact(null) }, '关闭'),
                ),
                h(
                  'pre',
                  {
                    style: {
                      flex: 1,
                      minHeight: 0,
                      overflow: 'auto',
                      fontSize: 12,
                      lineHeight: 1.45,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      color: artifact.error ? danger : ink,
                      margin: 0,
                    },
                  },
                  artifact.error || artifact.text,
                ),
              ),
            )
          : null,
      );
    }

    function CreateView(props) {
      const initial = props.initial || null;
      const [providers, setProviders] = useState(null);
      const [selected, setSelected] = useState(() =>
        initial ? (initial.members || []).map(m => ({ ...m, name: m.name || m.model })) : [],
      );
      const [name, setName] = useState(initial ? initial.name : '');
      const [maxRounds, setMaxRounds] = useState(initial ? String(initial.limits.maxRounds) : '4');
      const [maxTokens, setMaxTokens] = useState(initial ? String(initial.limits.maxTokens) : '40000');
      const [effortsMap, setEffortsMap] = useState({});
      const [permission, setPermission] = useState(
        initial ? initial.permission || 'danger-full-access' : 'danger-full-access',
      );
      const [cwd, setCwd] = useState(initial ? initial.cwd || '' : '');
      const [parallel, setParallel] = useState(initial ? initial.parallel === true : false);
      const [error, setError] = useState('');

      useEffect(() => {
        api('models').then(result => {
          if (result.ok) setProviders(result.providers || []);
          else setError(result.error || '拿不到模型列表');
        });
      }, []);

      const isPicked = (provider, model) => selected.some(s => s.provider === provider && s.model === model);

      const loadEfforts = useCallback(async (provider, model) => {
        const key = provider + '/' + model;
        setEffortsMap(prev => (prev[key] !== undefined ? prev : { ...prev, [key]: null }));
        let result = {};
        try {
          result = await api('efforts', { provider, model });
        } catch (err) {
          result = {};
        }
        const list = Array.isArray(result.efforts) ? result.efforts : [];
        setEffortsMap(prev => ({ ...prev, [key]: list }));
        if (list.length > 0) {
          const preferred = list.some(e => e.id === result.defaultEffort)
            ? result.defaultEffort
            : list[list.length - 1].id;
          setSelected(prev =>
            prev.map(s =>
              s.provider === provider && s.model === model && !s.effort ? { ...s, effort: preferred } : s,
            ),
          );
        }
      }, []);

      useEffect(() => {
        if (!initial) return;
        for (const m of initial.members || []) loadEfforts(m.provider, m.model);
      }, [initial, loadEfforts]);

      const toggle = (provider, model) => {
        if (isPicked(provider, model)) {
          setSelected(list => list.filter(s => !(s.provider === provider && s.model === model)));
          return;
        }
        setSelected(list => list.concat([{ provider, model, name: model }]));
        loadEfforts(provider, model);
      };

      const submit = async () => {
        setError('');
        if (selected.length === 0) {
          setError('至少勾一个成员');
          return;
        }
        const payload = {
          name: name.trim() || '未命名群聊',
          members: selected,
          maxRounds: Number(maxRounds) || 4,
          maxTokens: Number(maxTokens) || 40000,
          permission,
          parallel,
          cwd: cwd.trim(),
        };
        const result = initial
          ? await api('update', { id: initial.id, ...payload })
          : await api('create', payload);
        if (!result.ok) {
          setError(result.error || (initial ? '保存失败' : '创建失败'));
          return;
        }
        props.onDone();
      };

      return h(
        'div',
        null,
        h('div', { style: styles.section }, '群名'),
        h('input', {
          style: styles.input,
          value: name,
          placeholder: '比如：架构评审组',
          onChange: event => setName(event.target.value),
        }),
        h('div', { style: styles.section }, `成员（已选 ${selected.length}）`),
        providers === null
          ? h('div', { style: styles.note }, '正在加载模型列表…')
          : providers.map(p =>
              h(
                'div',
                { key: p.provider, style: { marginBottom: 10 } },
                h('div', { style: { fontSize: 12, color: dim, marginBottom: 4 } }, p.name || p.provider),
                h(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap' } },
                  p.models.map(m =>
                    h(
                      'button',
                      {
                        key: p.provider + '/' + m.id,
                        style: isPicked(p.provider, m.id)
                          ? { ...styles.chip, background: brand, color: '#fff', borderColor: 'transparent', cursor: 'pointer' }
                          : { ...styles.chip, cursor: 'pointer' },
                        onClick: () => toggle(p.provider, m.id),
                      },
                      m.name || m.id,
                    ),
                  ),
                ),
              ),
            ),
        selected.length > 0
          ? h(
              'div',
              null,
              h('div', { style: styles.section }, '成员设置（称呼 / 思考强度）'),
              selected.map((s, index) => {
                const key = s.provider + '/' + s.model;
                const list = effortsMap[key];
                const patch = changes =>
                  setSelected(prev => prev.map((x, j) => (j === index ? { ...x, ...changes } : x)));
                return h(
                  'div',
                  {
                    key,
                    style: { border: '1px solid ' + line, borderRadius: 8, padding: 8, marginBottom: 8 },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    h('input', {
                      style: { ...styles.input, flex: 1, marginBottom: 0 },
                      value: s.name,
                      placeholder: '群里的称呼',
                      onChange: event => patch({ name: event.target.value }),
                    }),
                    list === null
                      ? h('span', { style: styles.meta }, '…')
                      : Array.isArray(list) && list.length > 0
                        ? h(
                            'select',
                            {
                              style: styles.effortSelect,
                              value: s.effort || '',
                              onChange: event => patch({ effort: event.target.value || undefined }),
                            },
                            h('option', { value: '' }, '默认'),
                            list.map(e => h('option', { key: e.id, value: e.id }, e.name || e.id)),
                          )
                        : h('span', { style: styles.meta }, '无思考档位'),
                  ),
                  h('input', {
                    style: { ...styles.input, marginTop: 6, marginBottom: 0 },
                    value: s.persona || '',
                    placeholder: '性格 / 人设：比如“毒舌但严谨，爱抬杠”',
                    onChange: event => patch({ persona: event.target.value }),
                  }),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6, marginTop: 6 } },
                    h('input', {
                      style: { ...styles.input, flex: 1, marginBottom: 0 },
                      value: s.temperature ?? '',
                      placeholder: '温度 0-2（选填）',
                      inputMode: 'decimal',
                      onChange: event =>
                        patch({ temperature: event.target.value === '' ? undefined : event.target.value }),
                    }),
                    h('input', {
                      style: { ...styles.input, flex: 1, marginBottom: 0 },
                      value: s.maxTokens ?? '',
                      placeholder: '单次最大输出（选填）',
                      inputMode: 'numeric',
                      onChange: event =>
                        patch({ maxTokens: event.target.value === '' ? undefined : event.target.value }),
                    }),
                  ),
                );
              }),
            )
          : null,
        h('div', { style: styles.section }, '上限'),
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h(
            'label',
            { style: { flex: 1, fontSize: 12, color: dim } },
            '最多轮数',
            h('input', {
              style: { ...styles.input, marginTop: 4 },
              value: maxRounds,
              inputMode: 'numeric',
              onChange: event => setMaxRounds(event.target.value),
            }),
          ),
          h(
            'label',
            { style: { flex: 1, fontSize: 12, color: dim } },
            'token 上限',
            h('input', {
              style: { ...styles.input, marginTop: 4 },
              value: maxTokens,
              inputMode: 'numeric',
              onChange: event => setMaxTokens(event.target.value),
            }),
          ),
        ),
        h('div', { style: styles.section }, '权限'),
        h(
          'div',
          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          [
            ['read-only', '仅可查看'],
            ['workspace-write', '工作区内修改'],
            ['danger-full-access', '完全权限'],
          ].map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                style:
                  permission === id
                    ? { ...styles.chip, background: brand, color: '#fff', borderColor: 'transparent', cursor: 'pointer' }
                    : { ...styles.chip, cursor: 'pointer' },
                onClick: () => setPermission(id),
              },
              label,
            ),
          ),
        ),
        h('div', { style: styles.section }, '发言方式'),
        h(
          'button',
          {
            style: {
              ...(parallel ? styles.chip : styles.chip),
              cursor: 'pointer',
              background: parallel ? brand : 'transparent',
              color: parallel ? '#fff' : ink,
              borderColor: parallel ? 'transparent' : line,
            },
            onClick: () => setParallel(v => !v),
          },
          parallel ? '并行：同一轮大家同时说' : '串行：一个说完下一个说',
        ),
        h('div', { style: styles.section }, '工作区（可选）'),
        h('input', {
          style: styles.input,
          value: cwd,
          placeholder: '/data/.../某个目录',
          onChange: event => setCwd(event.target.value),
        }),
        error ? h('div', { style: styles.err }, error) : null,
        h(
          'div',
          { style: { marginTop: 16, display: 'flex', gap: 8 } },
          h('button', { style: styles.primary, onClick: submit }, initial ? '保存' : '创建群聊'),
          h('button', { style: styles.button, onClick: props.onCancel }, '取消'),
        ),
      );
    }

    function Panel() {
      const [groups, setGroups] = useState(null);
      const [view, setView] = useState({ kind: 'list' });
      const [error, setError] = useState('');

      const refresh = useCallback(async () => {
        const result = await api('list');
        if (result.ok) {
          setGroups(result.groups || []);
          setError('');
        } else {
          setError(result.error || '加载失败');
          setGroups([]);
        }
      }, []);

      useEffect(() => {
        refresh();
      }, [refresh]);

      if (view.kind === 'chat') {
        return h(
          'div',
          { style: styles.root },
          h(
            'div',
            { style: styles.header },
            h('button', { style: styles.ghost, onClick: () => { setView({ kind: 'list' }); refresh(); } }, '←'),
            h('div', { style: styles.title }, view.group.name),
            h(
              'div',
              { style: { fontSize: 12, color: dim } },
              view.group.members.map(m => m.name).join('、'),
            ),
            h(
              'button',
              { style: styles.ghost, onClick: () => setView({ kind: 'edit', group: view.group }) },
              '设置',
            ),
          ),
          h(ChatView, { group: view.group }),
        );
      }

      if (view.kind === 'edit') {
        return h(
          'div',
          { style: styles.root },
          h(
            'div',
            { style: styles.header },
            h(
              'button',
              { style: styles.ghost, onClick: () => setView({ kind: 'chat', group: view.group }) },
              '←',
            ),
            h('div', { style: styles.title }, '群设置'),
          ),
          h(
            'div',
            { style: styles.body },
            h(CreateView, {
              initial: view.group,
              onDone: async () => {
                const result = await api('list');
                const fresh = result.ok
                  ? (result.groups || []).find(x => x.id === view.group.id)
                  : null;
                setView(fresh ? { kind: 'chat', group: { ...fresh, history: fresh.history || [] } } : { kind: 'list' });
                refresh();
              },
              onCancel: () => setView({ kind: 'chat', group: view.group }),
            }),
          ),
        );
      }

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.header },
          h('div', { style: styles.title }, 'AI 群聊'),
          view.kind === 'create'
            ? null
            : h('button', { style: styles.primary, onClick: () => setView({ kind: 'create' }) }, '＋ 新建'),
        ),
        h(
          'div',
          { style: styles.body },
          error ? h('div', { style: styles.err }, error) : null,
          view.kind === 'create'
            ? h(CreateView, {
                onDone: () => {
                  setView({ kind: 'list' });
                  refresh();
                },
                onCancel: () => setView({ kind: 'list' }),
              })
            : groups === null
              ? h('div', { style: styles.note }, '正在加载…')
              : groups.length === 0
                ? h(
                    'div',
                    null,
                    h('div', { style: styles.note }, '还没有群聊。'),
                    h(
                      'div',
                      { style: { ...styles.note, marginTop: 8 } },
                      '建一个群，勾上几个模型，它们就会互相聊；你也可以插话，或者让它们干活、自己分工。',
                    ),
                  )
                : groups.map(g =>
                    h(
                      'div',
                      { key: g.id, style: styles.card },
                      h(
                        'div',
                        { style: styles.row },
                        h(
                          'div',
                          { style: { ...styles.title, fontSize: 14 } },
                          g.name,
                          g.running
                            ? h('span', { style: { fontSize: 11, color: brand, marginLeft: 6 } }, '● 运行中')
                            : null,
                        ),
                        h(
                          'button',
                          {
                            style: styles.ghost,
                            onClick: async () => {
                              await api('delete', { id: g.id });
                              refresh();
                            },
                          },
                          '删除',
                        ),
                      ),
                      h('div', { style: styles.meta }, g.members.map(m => m.name).join('、')),
                      h(
                        'div',
                        { style: styles.meta },
                        `${g.usage.tokens}/${g.limits.maxTokens} tokens · ${g.messages} 条消息 · 最多 ${g.limits.maxRounds} 轮`,
                      ),
                      h(
                        'div',
                        { style: { marginTop: 8 } },
                        h(
                          'button',
                          {
                            style: styles.primary,
                            onClick: () =>
                              setView({ kind: 'chat', group: { ...g, history: g.history || [] } }),
                          },
                          '进入',
                        ),
                      ),
                    ),
                  ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'ai-group-chat', order: 20, label: 'AI 群聊' },
            GroupIcon,
          ),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'ai-group-chat' }, Panel),
        );
      },
    };
  },
});
