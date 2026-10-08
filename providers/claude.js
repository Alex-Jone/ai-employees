// Claude CLI Provider
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

module.exports = {
  name: 'claude',
  displayName: 'Claude',
  command: 'claude',
  configFileName: 'CLAUDE.md',

  getArgs(employee, resumeId) {
    const args = resumeId ? ['--resume', resumeId] : [];
    // Code Reviewer 预批准只读 git 命令
    if (employee.id === 'code-reviewer') {
      args.push('--allowedTools', 'Bash(git *)', 'Read', 'Glob', 'Grep');
    }
    // 元仓类角色预批准 mysql 命令（避免外部路由权限流卡住）
    if (employee.dbConnection) {
      args.push('--allowedTools', 'Bash(/usr/local/mysql/bin/mysql *)', 'Read', 'Glob', 'Grep');
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
    return env;
  }
};
