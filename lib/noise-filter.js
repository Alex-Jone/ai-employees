const fs = require('fs');
const path = require('path');

const RULES_PATH = path.join(__dirname, '..', 'data', 'noise-rules.json');

// 内置规则（JSON 文件不存在时的回退）
const BUILTIN_SPINNERS = [
  'Booping', 'Calculating', 'Precipitating', 'Perusing',
  'Frosting', 'Whatchamacalliting', 'Churned', 'Cogitated',
  'Saut[ée]*d', 'Baked', 'Topsy-turvying',
  'Jerbugging', 'Shimmying'
];

let _rulesCache = null;
let _compiledPatterns = null; // { deepClean: [{ re, comment }], isNoise: [{ re, comment, maxLen }] }
let _spinnerRegex = null;     // combined spinner names regex

function loadRules() {
  try {
    if (fs.existsSync(RULES_PATH)) {
      _rulesCache = JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('  [规则] 加载 noise-rules.json 失败:', e.message);
  }

  const spinnerNames = (_rulesCache && _rulesCache.spinnerNames) || BUILTIN_SPINNERS;
  const spinnerAlt = spinnerNames.join('|');
  _spinnerRegex = new RegExp(spinnerAlt, 'i');

  // 编译 deepClean 规则：SPINNERS 占位符 → 实际 spinner 名列表
  const deepPat = (_rulesCache && _rulesCache.deepCleanPatterns) || [];
  _compiledPatterns = { deepClean: [], isNoise: [] };

  for (const p of deepPat) {
    const reStr = p.re.replace(/SPINNERS/g, spinnerAlt);
    try {
      _compiledPatterns.deepClean.push({
        re: new RegExp(reStr, p.flags || 'gm'),
        comment: p.comment || ''
      });
    } catch (e) {
      console.error(`  [规则] 无效正则: ${p.re} — ${e.message}`);
    }
  }

  // 编译 isNoiseLine 规则：SPINNER_WORDS → 实际 spinner 名 + 无标点版本
  const noiseTests = (_rulesCache && _rulesCache.isNoiseLineTests) || [];
  for (const t of noiseTests) {
    const spinnerWords = spinnerNames.map(s => s.replace(/[^a-zA-Z]/g, ''));
    const reStr = t.re.replace(/SPINNER_WORDS/g, spinnerWords.join('|'));
    try {
      _compiledPatterns.isNoise.push({
        re: new RegExp(reStr),
        comment: t.comment || '',
        maxLen: t.maxLen || 0
      });
    } catch (e) {
      console.error(`  [规则] 无效正则: ${t.re} — ${e.message}`);
    }
  }
}

// 首次加载
loadRules();

/**
 * 热重载规则（不改代码即可更新过滤规则）
 */
function reloadRules() {
  _rulesCache = null;
  _compiledPatterns = null;
  _spinnerRegex = null;
  loadRules();
  console.log('  [规则] 已重新加载 noise-rules.json');
  return true;
}

/**
 * 获取当前加载的规则（供 API 返回）
 */
function getRules() {
  return _rulesCache || { spinnerNames: BUILTIN_SPINNERS, deepCleanPatterns: [], isNoiseLineTests: [] };
}

/**
 * 深度清洗 PTY 输出文本：去 ANSI、动画、UI 噪音
 */
function deepClean(text) {
  let t = text;

  // 1. 基础 ANSI/控制字符清理（始终执行，不从规则文件加载）
  t = t.replace(/\x1b\[[?]?[0-9;]*[A-Za-z]/g, '');
  t = t.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  t = t.replace(/\x1b[()][A-Z0-9]/g, '');
  t = t.replace(/\x1b[>=<]/g, '');
  t = t.replace(/\r/g, '');
  t = t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  // 2. 规则文件中的可配置图案
  if (_compiledPatterns) {
    for (const p of _compiledPatterns.deepClean) {
      t = t.replace(p.re, '');
    }
  }

  // 3. 去重复空行
  t = t.replace(/\n{3,}/g, '\n\n');
  return t;
}

/**
 * 判断一行是否为噪音（供 extractConversations 使用）
 */
function isNoiseLine(line) {
  const t = line.trim();
  if (!t || t.length < 2) return true;

  if (!_compiledPatterns) return false;

  for (const rule of _compiledPatterns.isNoise) {
    if (rule.maxLen > 0 && t.length >= rule.maxLen) continue;
    if (rule.re.test(t)) return true;
  }
  return false;
}

/**
 * 从已清洗的文本中提取结构化对话
 * （逻辑不变，从 server.js 移入）
 */
function extractConversations(cleanedText) {
  const lines = cleanedText.split('\n');
  const conversations = [];
  let currentBlock = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isNoiseLine(trimmed)) continue;

    if (trimmed.startsWith('❯') && trimmed.length > 2) {
      let userText = trimmed.slice(1).trim();
      userText = userText.replace(/[·✳✶✻✽✢]\s*\w+….*$/, '').trim();
      if (userText && !userText.startsWith('Try "') && !userText.startsWith('Try ') && userText.length > 1) {
        if (currentBlock) conversations.push(currentBlock);
        currentBlock = { role: 'user', lines: [userText] };
      }
      continue;
    }

    if (trimmed.startsWith('⏺')) {
      let assistantText = trimmed.slice(1).trim();
      if (!assistantText) continue;
      assistantText = assistantText.replace(/[·✳✶✻✽✢]\s*\w+….*$/, '').trim();
      if (!assistantText) continue;

      if (/^(?:Searching|Searched|Read|Bash|Glob|Grep|Write|Edit|NotebookEdit)\s*\(/.test(assistantText)) {
        if (currentBlock && currentBlock.role === 'assistant') {
          const toolMatch = assistantText.match(/^(\w+)\((.{0,80})/);
          if (toolMatch) {
            currentBlock.lines.push(`[工具调用: ${toolMatch[1]}(${toolMatch[2]}...)]`);
          }
        }
        continue;
      }
      if (/^ed for \d+ pat/.test(assistantText)) continue;
      if (/^Reading \d+ file/.test(assistantText)) continue;

      if (currentBlock && currentBlock.role === 'assistant') {
        currentBlock.lines.push(assistantText);
      } else {
        if (currentBlock) conversations.push(currentBlock);
        currentBlock = { role: 'assistant', lines: [assistantText] };
      }
      continue;
    }

    if (trimmed.startsWith('⎿') && currentBlock && currentBlock.role === 'assistant') {
      const outputText = trimmed.slice(1).trim();
      if (outputText && outputText.length > 5 && !isNoiseLine(outputText) &&
          !/^(?:Running|Waiting|No output)/.test(outputText)) {
        currentBlock.lines.push(`  > ${outputText}`);
      }
      continue;
    }

    if (trimmed.startsWith('SESSION START:') || /^={10,}$/.test(trimmed)) {
      if (currentBlock) conversations.push(currentBlock);
      currentBlock = null;
      continue;
    }

    if (currentBlock && currentBlock.role === 'assistant' && trimmed.length > 5) {
      if (!/^(?:esc|origin|remotes\/origin)/.test(trimmed) || trimmed.length > 30) {
        currentBlock.lines.push(trimmed);
      }
    }
  }
  if (currentBlock) conversations.push(currentBlock);

  // 后处理：清理残留噪音
  for (const block of conversations) {
    block.lines = block.lines.filter(l => {
      const t = l.trim();
      if (t.length < 3) return false;
      if (isNoiseLine(t)) return false;
      if (/\d*thinking/.test(t) && t.length < 60) return false;
      if (/(?:Booping|Perusing|Frosting|Whatchamacalliting|Precipitating|Calculating|Shimmying|Jerbugging)/.test(t) && t.length < 80) return false;
      if (/^[^a-zA-Z\u4e00-\u9fff]{1,10}$/.test(t)) return false;
      if (/^\?\s*for/.test(t)) return false;
      if (/❯.*─{5,}/.test(t) || /─{5,}.*❯/.test(t)) return false;
      return true;
    });
  }

  let filteredConvs = conversations.filter(b => {
    if (b.lines.length === 0) return false;
    if (b.role === 'user' && b.lines.every(l => /^Try\s*"/.test(l.trim()) || /^Try\s/.test(l.trim()))) return false;
    return true;
  });

  const deduped = [];
  for (const block of filteredConvs) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.role === block.role) {
      const prevSig = prev.lines.join(' ').slice(0, 80);
      const curSig = block.lines.join(' ').slice(0, 80);
      if (prevSig === curSig) {
        if (block.lines.join('').length >= prev.lines.join('').length) {
          deduped[deduped.length - 1] = block;
        }
        continue;
      }
    }
    deduped.push(block);
  }
  return deduped;
}

module.exports = { deepClean, isNoiseLine, extractConversations, reloadRules, getRules, loadRules };
