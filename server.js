require('dotenv').config();
const _fs = require('fs');
const _path = require('path');

// 按天写入日志文件，同时保留 stdout 输出
const _logsDir = _path.join(__dirname, 'logs');
if (!_fs.existsSync(_logsDir)) _fs.mkdirSync(_logsDir, { recursive: true });

let _logDate = '', _logStream = null;
function _getLogStream() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (today !== _logDate) {
    if (_logStream) _logStream.end();
    _logDate = today;
    _logStream = _fs.createWriteStream(_path.join(_logsDir, `${today}.log`), { flags: 'a' });
  }
  return _logStream;
}

const _origLog = console.log.bind(console);
console.log = (...args) => {
  const now = new Date();
  const ts = now.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/\//g, '-');
  const line = `[${ts}] ` + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  _origLog(line);
  try { _getLogStream().write(line + '\n'); } catch {}
};

const _origErr = console.error.bind(console);
console.error = (...args) => {
  const now = new Date();
  const ts = now.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/\//g, '-');
  const line = `[${ts}] [ERROR] ` + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  _origErr(line);
  try { _getLogStream().write(line + '\n'); } catch {}
};

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const { getProvider, providers } = require('./providers');
const db = require('./db');
const noiseFilter = require('./lib/noise-filter');
const configMd = require('./lib/config-md');
const os = require('os');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

// 将配置中的占位符路径展开为真实绝对路径，提升可移植性。
// 支持 `${HOME}`、`${VAR}` 环境变量占位符，以及 `~/` 前缀。
// 展开只作用于内存中的运行配置；saveConfig() 写回时会反向还原为占位符。
function _expandPlaceholders(value) {
  if (typeof value === 'string') {
    let s = value;
    // ${HOME} / ${VAR} 环境变量占位符
    s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => {
      return process.env[name] ?? (name === 'HOME' ? os.homedir() : m);
    });
    // ~/ 前缀
    if (s.startsWith('~/')) s = os.homedir() + s.slice(1);
    return s;
  }
  if (Array.isArray(value)) return value.map(_expandPlaceholders);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = _expandPlaceholders(value[k]);
    return out;
  }
  return value;
}

function _collapsePlaceholders(value) {
  if (typeof value === 'string') {
    const home = os.homedir();
    if (value.startsWith(home)) return '~' + value.slice(home.length);
    return value;
  }
  if (Array.isArray(value)) return value.map(_collapsePlaceholders);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = _collapsePlaceholders(value[k]);
    return out;
  }
  return value;
}

// 对 config 中所有路径字段做占位符展开（就地修改，仅影响内存对象）
for (const emp of (config.employees || [])) {
  if (typeof emp.cwd === 'string') emp.cwd = _expandPlaceholders(emp.cwd);
  if (Array.isArray(emp.cwdList)) emp.cwdList = emp.cwdList.map(_expandPlaceholders);
  if (emp.dbConnection) emp.dbConnection = _expandPlaceholders(emp.dbConnection);
}

// === cc-connect API socket 助手 ===
const CC_CONNECT_SOCK = path.join(os.homedir(), '.cc-connect/run/api.sock');

// 通过 cc-connect api.sock 向活跃 DingTalk session 注入消息
// 消息会被 cc-connect 内部的 Claude 处理，结果自动回 DingTalk
function sendToCcConnect(fromEmpId, message, callback) {
  if (!fs.existsSync(CC_CONNECT_SOCK)) {
    console.log('[ccSend] api.sock 不存在，跳过');
    if (callback) callback(new Error('api.sock 不存在'));
    return;
  }
  // 1. 获取活跃 session 列表
  const getReq = http.request({ socketPath: CC_CONNECT_SOCK, path: '/sessions', method: 'GET' }, (res) => {
    let raw = '';
    res.on('data', d => raw += d);
    res.on('end', () => {
      let ccSessions;
      try { ccSessions = JSON.parse(raw); } catch { ccSessions = []; }
      if (!ccSessions.length) {
        console.log('[ccSend] 无活跃 cc-connect session');
        if (callback) callback(null, 0);
        return;
      }
      const text = `[来自 @${fromEmpId} 的回复]\n${message}`;
      let sent = 0;
      for (const sess of ccSessions) {
        const body = JSON.stringify({ project: sess.project, session_key: sess.session_key, message: text });
        const postReq = http.request(
          { socketPath: CC_CONNECT_SOCK, path: '/send', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
          (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => console.log(`[ccSend] → ${sess.session_key.slice(0, 40)}... ${d}`)); }
        );
        postReq.on('error', e => console.error('[ccSend] POST 失败:', e.message));
        postReq.write(body);
        postReq.end();
        sent++;
      }
      console.log(`[ccSend] ${fromEmpId} 回复已注入 ${sent} 个 cc-connect session`);
      if (callback) callback(null, sent);
    });
  });
  getReq.on('error', e => { console.error('[ccSend] GET sessions 失败:', e.message); if (callback) callback(e); });
  getReq.end();
}

// === 持久化存储 ===
const DATA_DIR = path.join(__dirname, 'data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const RESUME_FILE = path.join(DATA_DIR, 'resume-ids.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadResumeIds(map) {
  try {
    if (fs.existsSync(RESUME_FILE)) {
      const data = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf-8'));
      for (const [k, v] of Object.entries(data)) map.set(k, v);
      console.log(`  [持久化] 已加载 ${map.size} 个 resume ID`);
    }
  } catch (e) {
    console.error('  [持久化] 加载 resume-ids.json 失败:', e.message);
  }
}

function saveResumeIds(map) {
  try {
    ensureDir(DATA_DIR);
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    fs.writeFileSync(RESUME_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (e) {
    console.error('  [持久化] 保存 resume-ids.json 失败:', e.message);
  }
}

let _configSaving = false;
let _configDirty = false;

function saveConfig() {
  if (_configSaving) { _configDirty = true; return; }
  _configSaving = true;
  try {
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(_collapsePlaceholders(config), null, 2), 'utf-8');
  } catch (e) {
    console.error('保存 config.json 失败:', e.message);
  } finally {
    _configSaving = false;
    if (_configDirty) { _configDirty = false; saveConfig(); }
  }
}

function getLogPath(employeeId) {
  const dir = path.join(LOGS_DIR, employeeId);
  ensureDir(dir);
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  return path.join(dir, `${date}.log`);
}

function appendLog(employeeId, data) {
  try {
    const logPath = getLogPath(employeeId);
    fs.appendFile(logPath, data, () => {});
  } catch { /* 静默失败 */ }
}

function writeSessionMarker(employeeId, resumeId) {
  const marker = `\n${'='.repeat(60)}\n` +
    `SESSION START: ${new Date().toISOString()}` +
    (resumeId ? ` | resume: ${resumeId}` : ' | new session') +
    `\n${'='.repeat(60)}\n`;
  appendLog(employeeId, marker);
}

async function cleanOldLogs(maxDays = 7) {
  try {
    if (!fs.existsSync(LOGS_DIR)) return;
    const cutoff = Date.now() - maxDays * 86400000;

    const expiredByEmployee = {};
    for (const empDir of fs.readdirSync(LOGS_DIR)) {
      const dirPath = path.join(LOGS_DIR, empDir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.log')) continue;
        const dateStr = file.replace('.log', '');
        const fileDate = new Date(dateStr).getTime();
        if (fileDate && fileDate < cutoff) {
          if (!expiredByEmployee[empDir]) expiredByEmployee[empDir] = [];
          expiredByEmployee[empDir].push(path.join(dirPath, file));
        }
      }
    }

    // 对每个员工：先生成摘要并入库，成功后再删除文件
    for (const [empId, files] of Object.entries(expiredByEmployee)) {
      files.sort();
      try {
        await summarizeLogs(empId, files);
        // 摘要生成 + DB 入库成功后才删除文件
        for (const fp of files) {
          fs.unlinkSync(fp);
          console.log(`  [清理] 已删除旧日志: ${empId}/${path.basename(fp)}`);
        }
      } catch (err) {
        console.error(`  [清理] ${empId} 摘要入库失败，保留日志文件:`, err.message);
      }
    }
  } catch (e) {
    console.error('  [清理] 清理旧日志失败:', e.message);
  }
}

const HISTORY_DIR = path.join(DATA_DIR, 'history');
const SUMMARY_DIR = path.join(DATA_DIR, 'summary');
configMd.init(HISTORY_DIR);

// === 日志清洗 & 对话提取已移至 lib/noise-filter.js ===
const { deepClean, extractConversations } = noiseFilter;

// 将过期日志提取摘要后追加到 summary/{employeeId}.md（纯文件，无 DB）
async function summarizeLogs(employeeId, logFilePaths) {
  try {
    if (!logFilePaths.length) return;
    let summaryChunk = '';

    for (const fp of logFilePaths) {
      if (!fs.existsSync(fp)) continue;
      const raw = fs.readFileSync(fp, 'utf-8');
      const cleaned = deepClean(raw);
      const convs = extractConversations(cleaned);
      if (!convs.length) continue;

      const dateStr = path.basename(fp, '.log');
      summaryChunk += `\n---\n## ${dateStr} 对话摘要\n\n`;
      for (const block of convs) {
        if (block.role === 'user') {
          summaryChunk += `**用户**: ${block.lines.join(' ')}\n`;
        } else {
          const fullText = block.lines
            .filter(l => !/^\[工具调用:/.test(l.trim()) && !/^\s*>/.test(l))
            .join('\n');
          const truncated = fullText.length > 200 ? fullText.slice(0, 200) + '...' : fullText;
          summaryChunk += `**AI**: ${truncated}\n`;
        }
      }
    }

    if (!summaryChunk) return;

    const summaryPath = path.join(SUMMARY_DIR, `${employeeId}.md`);
    fs.appendFileSync(summaryPath, summaryChunk, 'utf-8');

    const maxSummarySize = 50 * 1024;
    const stat = fs.statSync(summaryPath);
    if (stat.size > maxSummarySize) {
      const content = fs.readFileSync(summaryPath, 'utf-8');
      fs.writeFileSync(summaryPath, content.slice(-maxSummarySize), 'utf-8');
    }

    console.log(`  [摘要] ${employeeId}: 已从 ${logFilePaths.length} 个过期日志生成摘要`);
  } catch (e) {
    console.error(`  [摘要] ${employeeId} 生成摘要失败:`, e.message);
  }
}

// 从文件解析近期日志（同步回退版本）
function generateHistoryContext(employeeId) {
  try {
    const empLogDir = path.join(LOGS_DIR, employeeId);
    if (!fs.existsSync(empLogDir)) return null;
    const logFiles = fs.readdirSync(empLogDir).filter(f => f.endsWith('.log')).sort().reverse();
    if (!logFiles.length) return null;

    // 读最近日志（最多 3 个文件，共 300KB raw 文本）
    let raw = '';
    const maxRaw = 300 * 1024;
    for (const f of logFiles.slice(0, 3)) {
      if (raw.length >= maxRaw) break;
      const fp = path.join(empLogDir, f);
      const stat = fs.statSync(fp);
      const start = Math.max(0, stat.size - (maxRaw - raw.length));
      raw += fs.readFileSync(fp, 'utf-8').slice(start > 0 ? start : 0);
    }

    // 深度清洗 + 提取对话
    const cleaned = deepClean(raw);
    const filteredConvs = extractConversations(cleaned);

    // 读取长期摘要
    const summaryPath = path.join(SUMMARY_DIR, `${employeeId}.md`);
    let summaryContent = '';
    if (fs.existsSync(summaryPath)) {
      summaryContent = fs.readFileSync(summaryPath, 'utf-8');
      // 摘要最多保留 10KB
      const maxSummary = 10 * 1024;
      if (summaryContent.length > maxSummary) {
        summaryContent = summaryContent.slice(-maxSummary);
      }
    }

    // 格式化近期对话为 Markdown
    let recentMd = '';
    for (const block of filteredConvs) {
      if (block.role === 'user') {
        recentMd += `### 用户提问\n${block.lines.join(' ')}\n\n`;
      } else {
        recentMd += `### AI 回复\n${block.lines.join('\n')}\n\n`;
      }
    }
    // 近期对话最多 20KB（截取尾部保留最新）
    const maxRecent = 20 * 1024;
    if (recentMd.length > maxRecent) {
      recentMd = recentMd.slice(-maxRecent);
    }

    // 合并输出
    let md = `# 对话历史 (${employeeId})\n\n`;
    md += `> 生成时间: ${new Date().toISOString()}\n\n`;

    if (summaryContent) {
      md += `## 历史摘要\n\n${summaryContent}\n\n`;
    }

    md += `## 近期对话\n\n${recentMd}`;

    // 总大小控制在 30KB
    const maxTotal = 30 * 1024;
    if (md.length > maxTotal) md = md.slice(-maxTotal);

    ensureDir(HISTORY_DIR);
    const histPath = path.join(HISTORY_DIR, `${employeeId}.md`);
    fs.writeFileSync(histPath, md, 'utf-8');

    console.log(`  [历史] ${employeeId}: 提取 ${filteredConvs.length} 个对话块, 写入 ${(md.length / 1024).toFixed(1)}KB`);
    return histPath;
  } catch (e) {
    console.error(`  [历史] 生成 ${employeeId} 历史上下文失败:`, e.message);
    return null;
  }
}

// 启动时初始化目录、清理旧日志
ensureDir(DATA_DIR);
ensureDir(LOGS_DIR);
ensureDir(HISTORY_DIR);
ensureDir(SUMMARY_DIR);

(async () => {
  try {
    await cleanOldLogs();
  } catch (err) {
    console.error('  [清理] 旧日志清理失败:', err.message);
  }
  // DB 初始化（可选功能，失败不影响主流程）
  db.init().catch(e => console.warn('  [DB] 初始化失败（可选）:', e.message));
  // 启动时生成所有项目配置 MD
  configMd.generateAllConfigs(config.employees);
})();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API: 返回员工配置
app.get('/api/config', (req, res) => {
  res.json(config);
});

// API: 返回会话状态
app.get('/api/status', (req, res) => {
  const status = {};
  for (const [id, session] of sessions) {
    status[id] = { alive: session.alive, pid: session.pty?.pid };
  }
  res.json(status);
});

// API: 返回所有员工的 resume ID 状态
app.get('/api/resume-status', (req, res) => {
  const result = {};
  for (const emp of config.employees) {
    result[emp.id] = resumeIds.has(emp.id) ? { hasResume: true, id: resumeIds.get(emp.id) } : { hasResume: false };
  }
  res.json(result);
});

// API: 返回某员工的日志文件列表
app.get('/api/logs/:employeeId', (req, res) => {
  const empDir = path.join(LOGS_DIR, req.params.employeeId);
  if (!fs.existsSync(empDir)) return res.json([]);
  const files = fs.readdirSync(empDir)
    .filter(f => f.endsWith('.log'))
    .map(f => {
      const stat = fs.statSync(path.join(empDir, f));
      return { filename: f, date: f.replace('.log', ''), size: stat.size };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  res.json(files);
});

// API: 读取某员工最新日志尾部（用于页面刷新后恢复历史）— 必须在 :filename 之前
app.get('/api/logs/:employeeId/latest', (req, res) => {
  const empDir = path.join(LOGS_DIR, req.params.employeeId);
  if (!fs.existsSync(empDir)) return res.json({ content: '' });
  const files = fs.readdirSync(empDir).filter(f => f.endsWith('.log')).sort().reverse();
  if (!files.length) return res.json({ content: '' });
  const filePath = path.join(empDir, files[0]);
  const tail = parseInt(req.query.tail) || 100 * 1024;
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - tail);
  const content = fs.readFileSync(filePath, { encoding: 'utf-8' }).slice(start > 0 ? start : 0);
  res.json({ content, date: files[0].replace('.log', '') });
});

// API: 读取某员工的日志文件内容
app.get('/api/logs/:employeeId/:filename', (req, res) => {
  const filePath = path.join(LOGS_DIR, req.params.employeeId, req.params.filename);
  if (!filePath.startsWith(LOGS_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: '日志文件不存在' });
  }
  const tail = parseInt(req.query.tail) || 200 * 1024; // 默认 200KB
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - tail);
  const stream = fs.createReadStream(filePath, { start });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  stream.pipe(res);
});

// API: 从数据库查询某员工的历史摘要
app.get('/api/db-summaries/:employeeId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const rows = await db.getSummaries(req.params.employeeId, limit);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: 从数据库查询某员工的近期对话
app.get('/api/db-conversations/:employeeId', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const limit = parseInt(req.query.limit) || 200;
    const rows = await db.getRecentConversations(req.params.employeeId, days, limit);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: 获取数据库统计信息
app.get('/api/db-stats', async (req, res) => {
  try {
    const rows = await db.getStats();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: 热重载噪音过滤规则（无需重启服务）
app.get('/api/noise-rules/reload', (req, res) => {
  noiseFilter.reloadRules();
  res.json({ ok: true, rules: noiseFilter.getRules() });
});

// POST /api/personality - 更新性格配置
app.post('/api/personality', (req, res) => {
  const { employeeId, personality } = req.body;
  const emp = config.employees.find(e => e.id === employeeId);
  if (!emp) return res.status(404).json({ error: '未找到员工: ' + employeeId });

  emp.personality = personality;

  // 回写 config.json
  saveConfig();

  // 生成配置 MD
  const provider = getProvider(emp);
  if (provider.configFileName) {
    if (emp.cwdMode === 'multi' && emp.cwdList) {
      emp.cwdList.forEach(dir => {
        if (fs.existsSync(dir)) configMd.generatePersonalityMd(dir, personality, emp, provider.configFileName);
      });
    } else if (fs.existsSync(emp.cwd)) {
      configMd.generatePersonalityMd(emp.cwd, personality, emp, provider.configFileName);
    }
  }

  res.json({ ok: true });
});

// POST /api/provider - 切换单个员工的 Provider
app.post('/api/provider', (req, res) => {
  const { employeeId, provider } = req.body;
  const emp = config.employees.find(e => e.id === employeeId);
  if (!emp) return res.status(404).json({ error: '未找到员工: ' + employeeId });
  if (!provider || !providers[provider]) {
    return res.status(400).json({ error: `未知 Provider: ${provider}` });
  }

  const prevProvider = emp.provider || 'claude';
  if (prevProvider === provider) {
    return res.json({
      ok: true,
      provider,
      configFileName: getProvider(emp).configFileName,
      restarted: false,
      employee: emp
    });
  }

  emp.provider = provider;
  resumeIds.delete(employeeId);
  saveResumeIds(resumeIds);
  saveConfig();
  if (getProvider(emp).configFileName) {
    configMd.writeEmployeeConfig(emp);
  }

  const providerInfo = getProvider(emp);
  const restarted = restartSession(
    emp,
    `[系统] 已切换到 ${providerInfo.displayName}，当前会话已自动重启`
  );

  broadcastAll({
    type: 'employee-updated',
    employeeId,
    employee: emp,
    provider,
    restarted
  });

  res.json({
    ok: true,
    provider,
    configFileName: providerInfo.configFileName,
    restarted,
    employee: emp
  });
});

// GET /api/deepseek-config
// 出于安全考虑，不回传明文 apiKey，只返回是否已配置，避免面板被访问时泄露密钥。
app.get('/api/deepseek-config', (req, res) => {
  const ds = config.deepseek || {};
  res.json({
    baseUrl: ds.baseUrl || 'https://api.deepseek.com',
    hasApiKey: !!ds.apiKey
  });
});

// POST /api/deepseek-config - 更新 DeepSeek 配置
app.post('/api/deepseek-config', (req, res) => {
  const { apiKey, baseUrl } = req.body;
  if (!config.deepseek) config.deepseek = {};
  // apiKey 传空字符串或未传时，保持原值不变，避免前端脱敏值覆盖真实密钥
  if (typeof apiKey === 'string' && apiKey.trim() !== '') config.deepseek.apiKey = apiKey.trim();
  if (baseUrl !== undefined && baseUrl !== '') config.deepseek.baseUrl = baseUrl;
  saveConfig();
  res.json({ ok: true, baseUrl: config.deepseek.baseUrl, hasApiKey: !!config.deepseek.apiKey });
});

// POST /api/mention - 将消息路由到目标员工的 PTY（供 cc-connect Claude 调用）
// 内容去重缓存：key = `${from}→${to}:${messageHash}`，60s TTL
const _mentionDedup = new Map(); // key → expireAt
function _isDupMention(from, to, message) {
  const key = `${from}→${to}:${message.slice(0, 200)}`;
  const now = Date.now();
  // 清理过期条目
  for (const [k, exp] of _mentionDedup) { if (now > exp) _mentionDedup.delete(k); }
  if (_mentionDedup.has(key)) return true;
  _mentionDedup.set(key, now + 60000); // 60s 内相同消息视为重复
  return false;
}

app.post('/api/mention', (req, res) => {
  const { from, to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to 和 message 为必填项' });

  const targetEmp = config.employees.find(e => e.id === to);
  if (!targetEmp) {
    const ids = config.employees.map(e => e.id).join(', ');
    return res.status(404).json({ error: `未找到角色: ${to}，可用: ${ids}` });
  }

  const sourceEmp = config.employees.find(e => e.id === from) || { id: from || 'cc-connect', name: from || 'CC Connect' };

  // 内容去重：60s 内相同发送方+目标+消息内容，直接拒绝
  if (_isDupMention(sourceEmp.id, to, message)) {
    console.log(`[/api/mention] 内容去重：${sourceEmp.id} → ${to} 消息在60s内已处理，忽略`);
    return res.json({ ok: true, to, deduplicated: true });
  }

  const isNew = !sessions.get(to)?.alive;
  // 刚创建的 session（< 30s）也要等待 Claude 加载完成
  const existingSession = sessions.get(to);
  const sessionAgeMs = existingSession ? Date.now() - existingSession._createdAt : 0;
  const minWait = (isNew || sessionAgeMs < 30000) ? 10000 : 0;
  try {
    let targetSession = sessions.get(to);
    if (!targetSession || !targetSession.alive) {
      targetSession = createSession(targetEmp, targetEmp.cwd);
    }
    const contextMsg = `[来自 @${sourceEmp.id}，回复请调用 /api/mention-reply] ${message}\r`;
    // 已运行的 session 用 30s 超时（等待空闲 ❯）；新 session 等待加载用 300s
    const watcherTimeout = (isNew || sessionAgeMs < 30000) ? 300000 : 30000;

    // 去重逻辑：
    // 1. 消息已送达（awaitingDelivery=false）→ 正在等 Claude 回复，拒绝重复注入
    // 2. 消息未送达（awaitingDelivery=true）→ 取消旧等待，替换为新请求
    if (targetSession._pendingMention) {
      if (!targetSession._pendingMention._awaitingDelivery) {
        // 已送达，等待 Claude 回复中，拒绝重复
        console.log(`[/api/mention] ${targetEmp.id} 已收到消息正在处理，拒绝重复注入`);
        return res.json({ ok: true, to: targetEmp.id, toName: targetEmp.name, queued: true, deduplicated: true });
      }
      // 未送达，取消旧的 writeWhenReady
      if (targetSession._cancelPendingWrite) {
        console.log(`[/api/mention] 取消 ${targetEmp.id} 旧的 writeWhenReady，替换为新请求`);
        targetSession._cancelPendingWrite();
        targetSession._cancelPendingWrite = null;
      }
    }

    targetSession._pendingMention = { respondTo: sourceEmp.id, captureFrom: targetSession.buffer.length, _awaitingDelivery: true };
    const cancelFn = writeWhenReady(targetSession, contextMsg, watcherTimeout, minWait, () => {
      // 消息实际写入时更新 captureFrom，开始计时
      if (targetSession._pendingMention) {
        targetSession._pendingMention.captureFrom = targetSession.buffer.length;
        targetSession._pendingMention._awaitingDelivery = false;
        targetSession._cancelPendingWrite = null; // 已写入，清除取消函数
        console.log(`[/api/mention] 消息已送达 ${targetEmp.id}，开始等待回复`);
      }
    });
    targetSession._cancelPendingWrite = cancelFn;
    broadcastAll({ type: 'mention-routed', from: sourceEmp.id, fromName: sourceEmp.name, to: targetEmp.id, toName: targetEmp.name, message: message.slice(0, 100) });
    console.log(`[/api/mention] ${sourceEmp.id} → ${targetEmp.id}: ${message.slice(0, 300)}`);
    res.json({ ok: true, to: targetEmp.id, toName: targetEmp.name, queued: isNew });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === 权限提示检测与转发 ===
// 检测 Claude Code 的权限确认提示（"Do you want to proceed?" + Yes/No 选项）
// 返回 { detected: true, command, description } 或 { detected: false }
function detectPermissionPrompt(buffer) {
  const tail = stripAnsi(buffer.slice(-3000));
  // Claude Code 权限提示特征：
  // 1. "Do you want to proceed?" 或 "This command requires approval" 或类似措辞
  // 2. 选项列表含 "Yes" / "No" 或 "Allow" / "Deny"
  const hasQuestion = /Do you want to proceed\?|Allow once|Allow for this session|This command requires approval/i.test(tail);
  const hasOptions = /[❯>]\s*1\.\s*Yes|[❯>]\s*Allow/i.test(tail) || /1\.\s*Yes\s*\n\s*2\.\s*No/i.test(tail);
  if (!hasQuestion || !hasOptions) return { detected: false };

  // 提取命令内容：通常在 "Bash command" 之后、选项之前
  let command = '';
  const lines = tail.split('\n');
  let capturing = false;
  let captureLines = [];
  for (const line of lines) {
    if (/Bash command|Bash\s*$/i.test(line)) {
      capturing = true;
      continue;
    }
    if (capturing) {
      if (/Do you want to proceed|Contains |Allow once/i.test(line)) {
        capturing = false;
        continue;
      }
      const trimmed = line.trim();
      if (trimmed && !/^[─━═]+$/.test(trimmed)) {
        captureLines.push(trimmed);
      }
    }
  }
  command = captureLines.join(' ').trim();

  // 提取描述（如 "Find failure reason"）
  let description = '';
  const descMatch = tail.match(/^\s{3,}([A-Z][^\n]{5,80})$/m);
  if (descMatch) description = descMatch[1].trim();

  return { detected: true, command: command || '(无法解析命令)', description };
}

// 向 cc-connect 转发权限请求
function forwardPermissionPrompt(employee, promptInfo) {
  const session = sessions.get(employee.id);
  if (!session) return;

  // 防重复：30s 内同一员工同一命令不重复转发
  const dedupKey = `perm:${employee.id}:${promptInfo.command.slice(0, 100)}`;
  if (session._lastPermForwardKey === dedupKey && session._lastPermForward && Date.now() - session._lastPermForward < 30000) return;
  session._lastPermForwardKey = dedupKey;
  session._lastPermForward = Date.now();
  session._pendingPermission = true;

  const msg = `[权限请求 @${employee.name}]\n` +
    `命令: ${promptInfo.command.slice(0, 500)}\n` +
    (promptInfo.description ? `说明: ${promptInfo.description}\n` : '') +
    `\n请回复"同意"允许执行，或"拒绝"阻止执行。\n` +
    `(也可调用 POST /api/permission-reply {"employee":"${employee.id}","allow":true/false})`;

  sendToCcConnect(employee.id, msg);
  broadcastAll({ type: 'permission-prompt', employeeId: employee.id, command: promptInfo.command.slice(0, 200) });
  console.log(`[权限转发] ${employee.name}: ${promptInfo.command.slice(0, 150)}`);
}

// POST /api/permission-reply - 回复权限请求（cc-connect 或前端调用）
app.post('/api/permission-reply', (req, res) => {
  const { employee: empId, allow } = req.body;
  if (!empId) return res.status(400).json({ error: 'employee 为必填项' });

  const session = sessions.get(empId);
  if (!session?.alive) {
    return res.status(404).json({ error: `员工 ${empId} 未在线` });
  }

  if (!session._pendingPermission) {
    return res.json({ ok: true, warning: '当前无待确认的权限请求' });
  }

  session._pendingPermission = false;
  // Claude Code 权限选择：1 = Yes, 2 = No
  const choice = allow ? '1' : '2';
  session.pty.write(choice + '\r');

  const emp = config.employees.find(e => e.id === empId);
  broadcastAll({ type: 'permission-reply', employeeId: empId, allow });
  console.log(`[权限回复] ${emp?.name || empId}: ${allow ? '同意' : '拒绝'}`);
  res.json({ ok: true, employeeId: empId, allow });
});

// POST /api/mention-reply - 目标角色将回复写回源角色的 PTY（Claude 手动调用时取消自动捕获）
app.post('/api/mention-reply', (req, res) => {
  const { from, to, message } = req.body;
  if (!from || !message) return res.status(400).json({ error: 'from 和 message 为必填项' });

  // 取消该 session 的自动捕获（Claude 已主动回复，避免重复）
  const fromSession = sessions.get(from);
  if (fromSession?._pendingMention) {
    if (fromSession._pendingMention._quietTimer) clearTimeout(fromSession._pendingMention._quietTimer);
    fromSession._pendingMention = null;
  }

  const replyTo = to || 'cc-connect';
  const targetEmp = config.employees.find(e => e.id === replyTo);
  const fromEmp = config.employees.find(e => e.id === from) || { id: from, name: from };

  if (!targetEmp) return res.status(404).json({ error: `未找到回复目标: ${replyTo}` });

  broadcastAll({ type: 'mention-reply', from: fromEmp.id, fromName: fromEmp.name, to: replyTo, toName: targetEmp.name, message: message.slice(0, 100) });
  console.log(`[/api/mention-reply] ${from} → ${replyTo}: ${message.slice(0, 300)}`);

  // cc-connect 通过 api.sock 发回 DingTalk；其他角色通过 PTY 注入
  if (targetEmp.provider === 'cc-connect') {
    sendToCcConnect(fromEmp.id, message);
    return res.json({ ok: true, delivered: true, via: 'cc-connect-api' });
  }

  const targetSession = sessions.get(replyTo);
  if (!targetSession?.alive) {
    console.log(`[/api/mention-reply] ${from} 回复 ${replyTo}（未在线，已丢弃）`);
    return res.json({ ok: true, delivered: false, reason: '目标未在线' });
  }
  targetSession.pty.write(`[来自 @${fromEmp.id} 的回复] ${message}\r`);
  res.json({ ok: true, delivered: true, via: 'pty' });
});

// GET /api/employees - 返回可用员工列表（供 cc-connect Claude 查询）
app.get('/api/employees', (req, res) => {
  res.json(config.employees.map(e => ({ id: e.id, name: e.name, description: e.description, running: !!sessions.get(e.id)?.alive })));
});

// POST /api/start - 启动指定角色（供 cc-connect Claude 调用）
app.post('/api/start', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id 为必填项' });
  const emp = config.employees.find(e => e.id === id);
  if (!emp) return res.status(404).json({ error: `未找到角色: ${id}` });
  if (sessions.get(id)?.alive) return res.json({ ok: true, alreadyRunning: true, message: `${emp.name} 已在运行` });
  try {
    createSession(emp, emp.cwd);
    console.log(`[/api/start] 已启动 ${emp.name} (${id})`);
    res.json({ ok: true, started: true, message: `${emp.name} 启动中，约 20 秒后可接受消息` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/reset-session - 彻底重置角色会话（清除 resume ID、历史、日志后重启）
app.post('/api/reset-session', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id 为必填项' });
  const emp = config.employees.find(e => e.id === id);
  if (!emp) return res.status(404).json({ error: `未找到角色: ${id}` });

  // 1. 停掉正在运行的会话
  const session = sessions.get(id);
  if (session?.alive) {
    session._restarting = true;
    session.pty.kill();
  }

  // 2. 清除内存中的 resume ID
  resumeIds.delete(id);
  saveResumeIds(resumeIds);

  // 3. 清除历史和摘要文件
  const histPath = path.join(HISTORY_DIR, `${id}.md`);
  const summaryPath = path.join(SUMMARY_DIR, `${id}.md`);
  try { if (fs.existsSync(histPath)) fs.unlinkSync(histPath); } catch {}
  try { if (fs.existsSync(summaryPath)) fs.unlinkSync(summaryPath); } catch {}

  // 4. 清除今天的日志文件（避免脏数据污染新会话）
  const today = new Date().toISOString().slice(0, 10);
  const todayLog = path.join(LOGS_DIR, id, `${today}.log`);
  try { if (fs.existsSync(todayLog)) fs.unlinkSync(todayLog); } catch {}

  console.log(`[系统] 已彻底重置 ${emp.name} (${id}) 的会话状态`);

  // 5. 延迟启动新会话（等旧 PTY 退出）
  setTimeout(() => {
    try {
      createSession(emp, emp.cwd);
      console.log(`[系统] ${emp.name} 已以全新会话启动`);
      broadcastAll({ type: 'session-reset', employeeId: id, employeeName: emp.name });
    } catch (e) {
      console.error(`[系统] ${emp.name} 重启失败:`, e.message);
    }
  }, 2000);

  res.json({ ok: true, message: `${emp.name} 正在重置，约 20 秒后恢复` });
});

// 会话管理
const sessions = new Map();
// 记录每个员工最近的 resume session ID（按 provider 通用）
const resumeIds = new Map();
loadResumeIds(resumeIds);

// === 自动审查：检测 git push 后触发 Code Reviewer ===
const lastAutoReviewTime = {};

function broadcastAll(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      try { client.send(payload); } catch {}
    }
  });
}

function restartSession(employee, notice) {
  const session = sessions.get(employee.id);
  if (!session || !session.alive || session._restarting) return false;
  session._restarting = true;
  const cwd = session.cwd || employee.cwd;
  session.pty.onExit(() => {
    console.log(`[${employee.name}] 正在使用新配置重启会话...`);
    try {
      const newSession = createSession(employee, cwd);
      for (const client of session.clients) {
        if (client.readyState !== 1) continue;
        newSession.clients.add(client);
        try {
          if (notice) {
            client.send(JSON.stringify({ type: 'data', data: `\r\n${notice}\r\n` }));
          }
          if (newSession.buffer) {
            client.send(JSON.stringify({ type: 'data', data: newSession.buffer }));
          }
        } catch {}
      }
      broadcastAll({ type: 'status', employeeId: employee.id, status: 'running' });
    } catch (e) {
      console.error(`[${employee.name}] 重启失败:`, e.message);
    }
  });
  session.pty.kill();
  return true;
}

function triggerAutoReview(sourceEmployee, reviewCwd) {
  const now = Date.now();
  const key = sourceEmployee.id;
  if (lastAutoReviewTime[key] && now - lastAutoReviewTime[key] < 60000) return; // 60s 防抖
  lastAutoReviewTime[key] = now;

  const reviewer = config.employees.find(e => e.id === 'code-reviewer');
  if (!reviewer) return;

  console.log(`[自动审查] ${sourceEmployee.name} 推送了代码 -> Code Reviewer 开始审查 ${reviewCwd}`);

  const prompt = `[自动审查] 检测到 ${sourceEmployee.name} 推送了代码到远程仓库（${reviewCwd}）。

请执行以下步骤进行代码审查：
1. 用 git -C ${reviewCwd} log --oneline -20 查看提交历史
2. 用 git -C ${reviewCwd} log --oneline --all | head -30 找到当前分支的 base（通常是 main/master/release 分支的分叉点）
3. 用 git -C ${reviewCwd} merge-base HEAD <base-branch> 找到分叉点 commit
4. 对分支的所有变更执行 git -C ${reviewCwd} diff <merge-base>..HEAD 进行完整代码审查
5. 如果无法确定 base 分支，则至少审查最近 5 个 commit：git -C ${reviewCwd} diff HEAD~5..HEAD

注意：请始终使用 git -C ${reviewCwd} 而不是 cd && git，以避免复合命令审批。
审查重点：安全性、性能、可读性、错误处理。
`;

  let session = sessions.get('code-reviewer');
  const isNew = !session || !session.alive;
  if (isNew) {
    session = createSession(reviewer, reviewCwd);
  }
  // 统一用 writeWhenReady：已运行时等 ❯ 后注入；新会话等 20s 冷启动再检测
  writeWhenReady(session, prompt, 300000, isNew ? 20000 : 0);

  broadcastAll({
    type: 'auto-review',
    source: sourceEmployee.id,
    sourceName: sourceEmployee.name,
    cwd: reviewCwd
  });
}

// === PTY 工具：等待 Claude Code 就绪提示符后再注入消息 ===
// Claude Code 在空闲时显示 ❯ (U+276F)，处理中显示 ✽
function stripAnsi(s) {
  return s
    .replace(/\x1b\[[?!]?[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '');
}

function isClaudeReady(buffer, debugId) {
  // 最后 1000 字节，去除 ANSI 后检测
  const tail = stripAnsi(buffer.slice(-1000));
  // ⏵⏸ 是 "accept edits" 等待用户确认标志，不是繁忙指示符，不列入 busy
  const hasBusy = /[✽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(tail.slice(-300));
  // ❯ 出现在末尾 50 字符内即视为就绪（不必严格在最后）
  // "accept edits" 状态下 ❯ 被状态栏推到上方，单独检测这种状态
  const hasPrompt = /[\u276f>]/.test(tail.slice(-50));
  const isAcceptEdits = /accept edits on/i.test(tail.slice(-200));
  const ready = (hasPrompt || isAcceptEdits) && !hasBusy;
  if (debugId && !ready) {
    const last80 = tail.slice(-80).replace(/\n/g, '↵').replace(/\r/g, '←');
    console.log(`[isClaudeReady] ${debugId}: NOT ready | hasBusy=${hasBusy} hasPrompt=${hasPrompt} isAcceptEdits=${isAcceptEdits} | tail="${last80}"`);
  }
  return ready;
}

// 向 PTY 注入消息：先写文本，200ms 后再单独发 Enter，避免 readline 在异常状态下吞 \r
function ptyWriteWithEnter(session, message) {
  if (!session.alive) return;
  const body = message.endsWith('\r') ? message.slice(0, -1) : message;
  session.pty.write(body);
  setTimeout(() => { if (session.alive) session.pty.write('\r'); }, 200);
}

// 等待 session 就绪后写入消息
// onDelivered: 消息实际写入时的回调（用于更新 captureFrom，在此之前不启动静默计时器）
// 返回一个 cancel() 函数，用于在新请求来时取消旧的等待
function writeWhenReady(session, message, timeoutMs = 300000, minWaitMs = 0, onDelivered) {
  if (!session.alive) return () => {};

  let done = false;
  const startAt = Date.now();

  function doWrite(forced = false) {
    if (done) return;
    done = true;
    const tail = stripAnsi(session.buffer.slice(-1000));
    const isAcceptEdits = /accept edits on/i.test(tail.slice(-200));
    const notReady = forced && !isClaudeReady(session.buffer);
    if (isAcceptEdits) {
      // "accept edits" 状态：先发 Escape 退出确认界面，再等 1s 注入
      console.log(`[writeWhenReady] 检测到 accept edits 状态，先发 ESC (${session.employeeId})`);
      session.pty.write('\x1b');
      setTimeout(() => {
        if (onDelivered) onDelivered();
        ptyWriteWithEnter(session, message);
        console.log(`[writeWhenReady] 消息已注入 (${session.employeeId}), 等待 ${minWaitMs}ms+${Date.now()-startAt-minWaitMs}ms`);
      }, 1000);
    } else if (notReady) {
      // 强制写入但 Claude 还未就绪：先发一个 \r 清空输入行，再等 800ms 写入
      console.log(`[writeWhenReady] 强制写入但 Claude 未就绪，先发 \\r 清空 (${session.employeeId})`);
      session.pty.write('\r');
      setTimeout(() => {
        if (onDelivered) onDelivered();
        ptyWriteWithEnter(session, message);
        console.log(`[writeWhenReady] 消息已注入 (${session.employeeId}), 等待 ${minWaitMs}ms+${Date.now()-startAt-minWaitMs}ms`);
      }, 800);
    } else {
      if (onDelivered) onDelivered();
      ptyWriteWithEnter(session, message);
      console.log(`[writeWhenReady] 消息已注入 (${session.employeeId}), 等待 ${minWaitMs}ms+${Date.now()-startAt-minWaitMs}ms`);
    }
  }

  function checkAndSchedule() {
    const elapsed = Date.now() - startAt;
    const waitLeft = minWaitMs - elapsed;
    if (waitLeft > 0) {
      const waitTimer = setTimeout(() => {
        if (done) return;
      if (isClaudeReady(session.buffer, session.employeeId)) {
          setTimeout(doWrite, 500);
        } else {
          registerWatcher();
        }
      }, waitLeft);
      const forceTimer = setTimeout(() => {
        if (!done) { clearTimeout(waitTimer); console.log(`[writeWhenReady] 超时强制写入 (${session.employeeId})`); doWrite(true); }
      }, timeoutMs);
      session._readyWatchers = session._readyWatchers || [];
      session._readyWatchers.push(() => { if (done) { clearTimeout(waitTimer); clearTimeout(forceTimer); return true; } return false; });
    } else {
      if (isClaudeReady(session.buffer, session.employeeId)) {
        setTimeout(doWrite, 500);
      } else {
        registerWatcher();
      }
    }
  }

  function registerWatcher() {
    session._readyWatchers = session._readyWatchers || [];
    const timeout = setTimeout(() => {
      if (!done) { console.log(`[writeWhenReady] 超时强制写入 (${session.employeeId})`); doWrite(true); }
    }, Math.max(5000, timeoutMs - (Date.now() - startAt)));
    session._readyWatchers.push(() => {
      if (done) { clearTimeout(timeout); return true; }
      if (isClaudeReady(session.buffer, session.employeeId)) {
        clearTimeout(timeout);
        setTimeout(doWrite, 500);
        return true;
      }
      return false;
    });
  }

  checkAndSchedule();
  // 返回取消函数：让新请求可以取消旧的 writeWhenReady 等待
  return () => { done = true; };
}

// 自动捕获 Claude 回复并转发给来源角色（服务端主动，不依赖 Claude 调用 API）
// 将 PTY 原始输出转换为干净文本：正确处理 \r（覆盖当前行），再去除 ANSI
function ptyOutputToText(raw) {
  const noAnsi = stripAnsi(raw);
  // 处理 \r：遇到 \r 不跟 \n，丢弃当前行缓冲（spinner 每帧覆盖同一行）
  let out = '';
  let lineBuf = '';
  for (let i = 0; i < noAnsi.length; i++) {
    const ch = noAnsi[i];
    if (ch === '\r') {
      if (noAnsi[i + 1] === '\n') {
        out += lineBuf + '\n'; lineBuf = ''; i++; // \r\n = 换行
      } else {
        lineBuf = ''; // \r 单独出现 = 回到行首，丢弃当前行内容
      }
    } else if (ch === '\n') {
      out += lineBuf + '\n'; lineBuf = '';
    } else {
      lineBuf += ch;
    }
  }
  if (lineBuf) out += lineBuf;
  return out;
}

function autoForwardMentionReply(session, employee) {
  if (!session._pendingMention) return;
  const pm = session._pendingMention;
  const { respondTo, captureFrom, _awaitingDelivery } = pm;
  if (_awaitingDelivery) return; // 消息还未送达，不处理
  // 清除 quietTimer，防止重复触发
  if (pm._quietTimer) { clearTimeout(pm._quietTimer); pm._quietTimer = null; }
  session._pendingMention = null; // 立即清除，防止重复调用

  const rawOutput = session.buffer.slice(captureFrom);
  const text = ptyOutputToText(rawOutput);

  const lines = text.split('\n').filter(line => {
    const s = line.trim();
    if (s.length === 0) return false;
    // 去除 Claude Code 框架字符行
    if (/^[╭╰╮╯│├─┤╴╸╺╻╵╷\s]+$/.test(s)) return false;
    // 去除 spinner/busy 行
    if (/^[✽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⏵⏸✓●○•◦⏺]/.test(s)) return false;
    // 去除 esc to interrupt / token 计数行
    if (/esc to interrupt/i.test(s) || (/\d+\s*tokens?/i.test(s) && s.length < 80)) return false;
    // 去除提示符行
    if (/^[❯>]\s/.test(s)) return false;
    // 去除被回显的原始注入消息（包含路由前缀）
    if (s.includes('[来自 @') && (s.includes('回复请调用') || s.includes('/api/mention'))) return false;
    // 去除几乎全是符号/单字符的噪音行（有效字符 < 4）
    if (s.replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3040-\u30ff]/g, '').length < 4) return false;
    return true;
  });

  const reply = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!reply || reply.length < 15) {
    console.log(`[autoReply] ${employee.id} 回复内容太短，跳过 (${reply.length}字符)`);
    return;
  }

  const respondEmp = config.employees.find(e => e.id === respondTo);
  broadcastAll({ type: 'mention-reply', from: employee.id, fromName: employee.name, to: respondTo, toName: respondEmp?.name || respondTo, message: reply.slice(0, 100) });
  console.log(`[autoReply] ${employee.id} → ${respondTo}: ${reply.slice(0, 300)}`);

  const respondEmpConf = config.employees.find(e => e.id === respondTo);
  if (respondEmpConf?.provider === 'cc-connect') {
    sendToCcConnect(employee.id, reply.slice(0, 3000));
  } else {
    const respondSession = sessions.get(respondTo);
    if (!respondSession?.alive) {
      console.log(`[autoReply] ${employee.id} → ${respondTo}（未在线，已丢弃）`);
      return;
    }
    respondSession.pty.write(`[来自 @${employee.id} 的回复]\n${reply.slice(0, 3000)}\r`);
  }
}

// === @mention 路由：任意角色终端都可用 @role-id 消息 发送到目标角色 ===
function handleAtMention(sourceEmp, targetEmp, message, sourceWs) {
  const shortMsg = message.length > 80 ? message.slice(0, 80) + '…' : message;
  const notice = `\r\n\x1b[33m[→ @${targetEmp.id}] ${shortMsg}\x1b[0m\r\n`;
  try { sourceWs.send(JSON.stringify({ type: 'data', data: notice })); } catch {}

  let targetSession = sessions.get(targetEmp.id);
  if (!targetSession || !targetSession.alive) {
    try {
      targetSession = createSession(targetEmp, targetEmp.cwd);
    } catch (e) {
      const errMsg = `\r\n\x1b[31m[错误] 无法启动 @${targetEmp.id}: ${e.message}\x1b[0m\r\n`;
      try { sourceWs.send(JSON.stringify({ type: 'data', data: errMsg })); } catch {}
      return;
    }
  }

  const contextMsg = `[来自 @${sourceEmp.id}] ${message}\r`;
  const isNew = !sessions.get(targetEmp.id) || targetSession._createdAt > Date.now() - 30000;
  const watcherTimeout = isNew ? 300000 : 30000;
  // 去重：已送达则拒绝；未送达则取消旧等待
  if (targetSession._pendingMention) {
    if (!targetSession._pendingMention._awaitingDelivery) {
      console.log(`[@mention] ${targetEmp.id} 正在处理中，忽略重复 @`);
      return;
    }
    if (targetSession._cancelPendingWrite) {
      targetSession._cancelPendingWrite();
      targetSession._cancelPendingWrite = null;
    }
  }
  targetSession._pendingMention = { respondTo: sourceEmp.id, captureFrom: targetSession.buffer.length, _awaitingDelivery: true };
  const cancelFn = writeWhenReady(targetSession, contextMsg, watcherTimeout, isNew ? 10000 : 0, () => {
    if (targetSession._pendingMention) {
      targetSession._pendingMention.captureFrom = targetSession.buffer.length;
      targetSession._pendingMention._awaitingDelivery = false;
      targetSession._cancelPendingWrite = null;
    }
  });
  targetSession._cancelPendingWrite = cancelFn;

  console.log(`[@mention] ${sourceEmp.id} → ${targetEmp.id}: ${message.slice(0, 300)}`);
  broadcastAll({
    type: 'mention-routed',
    from: sourceEmp.id,
    fromName: sourceEmp.name,
    to: targetEmp.id,
    toName: targetEmp.name,
    message: message.slice(0, 100)
  });
}


function ensureLocalhostPermissions(dir, employeeId) {
  const settingsPath = path.join(dir, '.claude', 'settings.local.json');
  const LOCALHOST_PERMS = [
    'Bash(*)',
    'Read(*)',
    'Edit(*)',
    'Write(*)',
  ];
  // 元仓类角色需要预批准 mysql CLI（避免外部路由权限流卡住）
  const empForPerms = config.employees.find(e => e.id === employeeId);
  if (empForPerms && empForPerms.dbConnection) {
    LOCALHOST_PERMS.push('Bash(/usr/local/mysql/bin/mysql*)');
  }
  try {
    const claudeDir = path.join(dir, '.claude');
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
    let d = {};
    if (fs.existsSync(settingsPath)) {
      try { d = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
    }
    if (!d.permissions) d.permissions = {};
    if (!d.permissions.allow) d.permissions.allow = [];
    const before = d.permissions.allow.length;
    for (const p of LOCALHOST_PERMS) {
      if (!d.permissions.allow.includes(p)) d.permissions.allow.push(p);
    }
    if (d.permissions.allow.length > before) {
      fs.writeFileSync(settingsPath, JSON.stringify(d, null, 2), 'utf-8');
    }
  } catch (e) {
    console.error(`  [settings] 写入 ${settingsPath} 失败:`, e.message);
  }
}

function ensureMcpConfig(dir) {
  const mcpPath = path.join(dir, '.mcp.json');
  const confluenceEntry = {
    command: 'node',
    args: [path.join(__dirname, 'mcp-servers', 'confluence.js')]
  };
  try {
    let mcpConfig = {};
    if (fs.existsSync(mcpPath)) {
      mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    }
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    if (!mcpConfig.mcpServers.confluence) {
      mcpConfig.mcpServers.confluence = confluenceEntry;
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
      console.log(`  [MCP] 已写入 ${mcpPath}`);
    }
  } catch (e) {
    console.error(`  [MCP] 写入 ${mcpPath} 失败:`, e.message);
  }
}

function createSession(employee, targetCwd) {
  const cwd = targetCwd || employee.cwd;
  // 检查工作目录是否存在
  if (!fs.existsSync(cwd)) {
    throw new Error(`工作目录不存在: ${cwd}`);
  }

  // 获取 Provider
  const provider = getProvider(employee);

  // cc-connect 等无 configFileName 的 provider 跳过 CLAUDE.md/MCP/历史生成
  if (provider.configFileName) {
    ensureMcpConfig(cwd);
    ensureLocalhostPermissions(cwd, employee.id);
    generateHistoryContext(employee.id);
    configMd.writeEmployeeConfig(employee, cwd);
  }

  const spawnEnv = provider.getSpawnEnv({ ...process.env, TERM: 'xterm-256color' });

  // 尝试复用之前的 session
  const lastResumeId = resumeIds.get(employee.id);
  const args = provider.getArgs(employee, lastResumeId);

  const term = pty.spawn(provider.command, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: cwd,
    env: spawnEnv
  });

  const session = {
    pty: term,
    buffer: '',
    clients: new Set(),
    alive: true,
    employeeId: employee.id,
    cwd,
    _createdAt: Date.now()
  };

  if (lastResumeId) {
    console.log(`[${employee.name}] 恢复会话 --resume ${lastResumeId}`);
  }
  writeSessionMarker(employee.id, lastResumeId);

  term.onData((data) => {
    session.buffer += data;
    appendLog(employee.id, data);
    // 限制缓冲区大小，同时修正 captureFrom 绝对偏移
    if (session.buffer.length > 200000) {
      const trimAt = session.buffer.length - 100000;
      session.buffer = session.buffer.slice(-100000);
      if (session._pendingMention) {
        session._pendingMention.captureFrom = Math.max(0, session._pendingMention.captureFrom - trimAt);
      }
    }

    // 检测 resume 失败：会话 ID 已过期或被清除
    if (!session._resumeFailed && provider.detectResumeFailed(data)) {
      session._resumeFailed = true;
      const oldId = resumeIds.get(employee.id);
      console.log(`[${employee.name}] resume 失败，会话 ID 已失效: ${oldId}`);
      resumeIds.delete(employee.id);
      saveResumeIds(resumeIds);
      // 等当前进程退出后自动以新会话重启（最多重试3次防死循环）
      const retryCount = session._resumeRetryCount || 0;
      if (retryCount >= 3) {
        console.log(`[${employee.name}] resume 重试已达上限，放弃自动恢复`);
        return;
      }
      term.onExit(() => {
        console.log(`[${employee.name}] 以新会话重新启动 (第${retryCount + 1}次)...`);
        try {
          const newSession = createSession(employee, cwd);
          newSession._resumeRetryCount = retryCount + 1;
          for (const client of session.clients) {
            if (client.readyState === 1) {
              newSession.clients.add(client);
              try {
                client.send(JSON.stringify({ type: 'data', data: `\r\n[系统] resume 失败，已自动以新会话重启\r\n` }));
                if (newSession.buffer) {
                  client.send(JSON.stringify({ type: 'data', data: newSession.buffer }));
                }
              } catch {}
            }
          }
          broadcastAll({ type: 'status', employeeId: employee.id, status: 'running' });
        } catch (e) {
          console.error(`[${employee.name}] 重启失败:`, e.message);
        }
      });
    }

    // 检测 context 用量溢出：100% context used 或 Input is too long
    // 自动清除 resume ID 并重启会话，避免角色卡死
    if (!session._contextOverflow) {
      const quickCheck = data.replace(/\x1b\[[?]?[0-9;]*[A-Za-z]/g, '');
      const isContextFull = /100%\s*context\s*used/i.test(quickCheck) ||
        /Input is too long/i.test(quickCheck) ||
        /invalid_request_error.*too long/i.test(quickCheck);
      if (isContextFull) {
        session._contextOverflow = true;
        const oldId = resumeIds.get(employee.id);
        console.log(`[${employee.name}] ⚠️ Context 溢出检测到，自动重置会话 (旧 resume: ${oldId})`);
        resumeIds.delete(employee.id);
        saveResumeIds(resumeIds);
        broadcastAll({
          type: 'context-overflow',
          employeeId: employee.id,
          employeeName: employee.name
        });
        // 延迟 3s 后 kill，让当前输出刷完
        setTimeout(() => {
          if (!session.alive) return;
          session._restarting = true;
          term.onExit(() => {
            console.log(`[${employee.name}] Context 溢出，以新会话重新启动...`);
            try {
              const newSession = createSession(employee, cwd);
              for (const client of session.clients) {
                if (client.readyState === 1) {
                  newSession.clients.add(client);
                  try {
                    client.send(JSON.stringify({ type: 'data', data: `\r\n\x1b[33m[系统] 检测到 context 溢出，已自动以新会话重启\x1b[0m\r\n` }));
                    if (newSession.buffer) {
                      client.send(JSON.stringify({ type: 'data', data: newSession.buffer }));
                    }
                  } catch {}
                }
              }
              broadcastAll({ type: 'status', employeeId: employee.id, status: 'running' });
            } catch (e) {
              console.error(`[${employee.name}] Context 溢出重启失败:`, e.message);
            }
          });
          term.kill();
        }, 3000);
      }
    }

    // 捕获 resume session ID
    const newResumeId = provider.captureResumeId(data);
    if (newResumeId) {
      resumeIds.set(employee.id, newResumeId);
      saveResumeIds(resumeIds);
      console.log(`[${employee.name}] 记录 resume ID: ${newResumeId}`);
    }
    // 检测 git push 成功，触发自动审查（综合多种匹配策略）
    // 因 PTY 数据分片，仅在当前数据块含成功关键词时才做 buffer 累积检测
    if (employee.category === 'project') {
      const quickClean = data.replace(/\x1b\[[?]?[0-9;]*[A-Za-z]/g, '');
      const maybeSuccess =
        /[0-9a-f]{7,}\.\.[0-9a-f]{7,}/.test(quickClean) ||
        /remote:/.test(quickClean) ||
        /推送成功|pushed successfully|已推送/i.test(quickClean);
      if (maybeSuccess) {
        const tail = session.buffer.slice(-30000);
        const clean = tail.replace(/\x1b\[[?]?[0-9;]*[A-Za-z]/g, '')
                          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
                          .replace(/\x1b[()][A-Z0-9]/g, '')
                          .replace(/\r/g, '');
        // 需要同时满足：1) 有 git push 命令  2) 有 push 成功标志
        const hasPushCmd = /git\s+push\b/.test(clean);
        const hasPushSuccess =
          // 标准 git push 输出 "hash..hash branch -> branch"
          /[0-9a-f]{7,}\.\.[0-9a-f]{7,}\s+\S+\s+->\s+\S+/.test(clean) ||
          // remote: merge_request/pull URL（GitLab/GitHub push 成功提示）
          /remote:.*merge_request|remote:.*pull\//.test(clean) ||
          // 推送完成后 Claude 确认消息（中/英文）
          /推送成功|pushed successfully|已推送/i.test(clean);
        if (hasPushCmd && hasPushSuccess) {
          // 尝试从输出中提取实际 push 的目录
          let reviewDir = cwd;
          const cdMatch = clean.match(/cd\s+(\/\S+)\s*&&\s*.*git\s+push/);
          if (cdMatch && fs.existsSync(cdMatch[1])) {
            reviewDir = cdMatch[1];
          }
          triggerAutoReview(employee, reviewDir);
        }
      }
    }
    // === 权限提示检测：仅在有 pending mention（来自 cc-connect 的任务）时检测并转发 ===
    if (session._pendingMention && !session._pendingPermission) {
      const quickClean2 = data.replace(/\x1b\[[?]?[0-9;]*[A-Za-z]/g, '');
      if (/Do you want to proceed|This command requires approval|1\.\s*Yes/i.test(quickClean2)) {
        const permInfo = detectPermissionPrompt(session.buffer);
        if (permInfo.detected) {
          forwardPermissionPrompt(employee, permInfo);
        }
      }
    }
    // 批量合并 PTY 输出，减少 WebSocket 消息频率，防止前端高频渲染闪烁
    session._wsBuf = (session._wsBuf || '') + data;
    if (!session._wsTimer) {
      session._wsTimer = setTimeout(() => {
        const chunk = session._wsBuf;
        session._wsBuf = '';
        session._wsTimer = null;
        for (const client of session.clients) {
          if (client.readyState === 1) {
            try {
              client.send(JSON.stringify({ type: 'data', data: chunk }));
            } catch (e) {
              // ignore send errors
            }
          }
        }
      }, 8);
    }

    // === 触发 ready watchers（等待 ❯ 提示符后自动注入消息）===
    if (session._readyWatchers?.length) {
      session._readyWatchers = session._readyWatchers.filter(w => !w(data));
    }

    // === 自动回复捕获：等待 Claude 回到 ❯ 提示符后触发，60s 静默兜底 ===
    if (session._pendingMention && !session._pendingMention._awaitingDelivery) {
      const pm = session._pendingMention;
      const captured = session.buffer.length - pm.captureFrom;
      // 标记 Claude 已开始处理（buffer 增长 > 200 字节，排除 prompt echo）
      if (captured > 200) pm._startedProcessing = true;
      if (pm._quietTimer) clearTimeout(pm._quietTimer);
      if (pm._startedProcessing && isClaudeReady(session.buffer)) {
        // Claude 回到空闲提示符，稳定 3s 后再捕获（避免流式输出还未刷完）
        pm._quietTimer = setTimeout(() => {
          // 再次确认仍然 idle（防止 Claude 紧接着又开始工作）
          if (session._pendingMention === pm && isClaudeReady(session.buffer)) {
            autoForwardMentionReply(session, employee);
          } else if (session._pendingMention === pm) {
            // 还没 idle，改为 60s 兜底
            pm._quietTimer = setTimeout(() => autoForwardMentionReply(session, employee), 60000);
          }
        }, 3000);
      } else {
        // 尚未完成，60s 静默兜底
        pm._quietTimer = setTimeout(() => autoForwardMentionReply(session, employee), 60000);
      }
    }
  });

  term.onExit(({ exitCode }) => {
    // 清除 WebSocket 批量发送定时器，防止访问已退出 session
    if (session._wsTimer) {
      clearTimeout(session._wsTimer);
      session._wsTimer = null;
    }
    session.alive = false;
    // 如果是 resume 失败触发的退出，不通知前端 exit（会自动重启）
    if (!session._resumeFailed && !session._restarting) {
      for (const client of session.clients) {
        if (client.readyState === 1) {
          try {
            client.send(JSON.stringify({ type: 'exit', exitCode }));
          } catch (e) {
            // ignore
          }
        }
      }
    }
    sessions.delete(employee.id);
    broadcastAll({ type: 'status', employeeId: employee.id, status: 'stopped' });
    console.log(`[${employee.name}] 会话已结束 (exit code: ${exitCode}${session._resumeFailed ? ', resume失败将重启' : session._restarting ? ', 配置变更将重启' : ''})`);
  });

  sessions.set(employee.id, session);
  broadcastAll({ type: 'status', employeeId: employee.id, status: 'running' });
  console.log(`[${employee.name}] 会话已启动 (PID: ${term.pid}, CWD: ${cwd})`);
  return session;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const employeeId = url.searchParams.get('employee');
  const employee = config.employees.find(e => e.id === employeeId);

  if (!employee) {
    ws.send(JSON.stringify({ type: 'error', message: '未知员工: ' + employeeId }));
    ws.close();
    return;
  }

  // 每次都从 Map 取最新 session 引用，确保重连时不会用到过期对象
  function getSession() { return sessions.get(employeeId); }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'start') {
      try {
        let session = getSession();
        if (!session || !session.alive) {
          session = createSession(employee, msg.targetCwd);
        }
        session.clients.add(ws);

        // 回放缓冲区内容
        if (session.buffer) {
          ws.send(JSON.stringify({ type: 'data', data: session.buffer }));
        }
        ws.send(JSON.stringify({ type: 'started' }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    }

    const session = getSession();
    if (msg.type === 'input' && session?.alive) {
      // @mention 路由：格式 "@role-id 消息内容"
      const atMatch = msg.data.match(/^@([\w-]+)\s([\s\S]+)/);
      if (atMatch) {
        const targetId = atMatch[1];
        const targetMessage = atMatch[2];
        const targetEmp = config.employees.find(e => e.id === targetId);
        if (targetEmp && targetId !== employeeId) {
          handleAtMention(employee, targetEmp, targetMessage, ws);
          return;
        }
      }
      session.pty.write(msg.data);
    }

    if (msg.type === 'resize' && session?.alive) {
      try {
        session.pty.resize(msg.cols, msg.rows);
      } catch {
        // ignore resize errors
      }
    }

    if (msg.type === 'stop' && session?.alive) {
      console.log(`[${employee.name}] 正在停止会话...`);
      session.pty.kill();
    }
  });

  ws.on('close', () => {
    const session = getSession();
    if (session) {
      session.clients.delete(ws);
    }
  });
});

// POST /api/restart - 重启整个服务（前端按钮调用）
app.post('/api/restart', (req, res) => {
  console.log('[系统] 收到重启请求，正在重启服务...');
  res.json({ ok: true, message: '服务正在重启，请稍后刷新页面' });
  // 给响应时间发送完毕
  setTimeout(() => {
    saveResumeIds(resumeIds);
    for (const [, session] of sessions) {
      if (session.alive) session.pty.kill();
    }
    // 用明确路径启动新进程，detached 使其脱离当前进程组
    const { spawn } = require('child_process');
    const nodeBin = process.execPath; // 当前 node 的绝对路径
    const scriptPath = path.join(__dirname, 'server.js');
    console.log(`[系统] 重启: ${nodeBin} ${scriptPath}`);
    const child = spawn(nodeBin, [scriptPath], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.unref();
    process.exit(0);
  }, 500);
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在关闭所有会话...');
  saveResumeIds(resumeIds);
  for (const [, session] of sessions) {
    if (session.alive) {
      session.pty.kill();
    }
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   AI Employees Dashboard             ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log('  员工列表:');
  config.employees.forEach(e => {
    const p = getProvider(e);
    console.log(`    ${e.avatar} ${e.name.padEnd(15)} [${p.displayName}] → ${e.cwd}`);
  });
  console.log('');

  // 自动启动标记了 autoStart: true 的角色
  const autoStartList = config.employees.filter(e => e.autoStart);
  if (autoStartList.length) {
    console.log(`  [自动启动] 正在启动 ${autoStartList.map(e => e.name).join(', ')}...`);
    autoStartList.forEach(emp => {
      try {
        createSession(emp, emp.cwd);
        console.log(`  [自动启动] ✓ ${emp.name} 已启动`);
      } catch (e) {
        console.error(`  [自动启动] ✗ ${emp.name} 启动失败: ${e.message}`);
      }
    });
  }
});
