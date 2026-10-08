// DeepSeek V4 Provider — 通过 Claude Code CLI 接入，使用 DeepSeek API
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function getDeepSeekConfig() {
  try {
    const cfg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config.json'), 'utf-8'));
    return cfg.deepseek || {};
  } catch {
    return {};
  }
}

module.exports = {
  name: 'deepseek',
  displayName: 'DeepSeek V4',
  command: 'claude',
  configFileName: 'DEEPSEEK.md',
  getDeepSeekConfig,

  getArgs(employee, resumeId) {
    const args = resumeId ? ['--resume', resumeId] : [];
    if (employee.id === 'code-reviewer') {
      args.push('--allowedTools', 'Bash(git:*)', 'Read', 'Glob', 'Grep');
    }
    return args;
  },

  captureResumeId(data) {
    const re = new RegExp(`claude\\s+--resume\\s+(${UUID_PATTERN})`);
    const match = data.match(re);
    return match ? match[1] : null;
  },

  detectResumeFailed(data) {
    return /No conversation found with session ID/.test(data);
  },

  getSpawnEnv(baseEnv) {
    const env = { ...baseEnv };
    delete env.CLAUDECODE;
    const cfg = getDeepSeekConfig();
    const apiKey = cfg.apiKey || process.env.DEEPSEEK_API_KEY;
    const baseUrl = cfg.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    return env;
  }
};
