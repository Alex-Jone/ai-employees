// GitHub Copilot CLI Provider
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

module.exports = {
  name: 'copilot',
  displayName: 'Copilot',
  command: 'copilot',
  configFileName: 'COPILOT.md',

  getArgs(employee, resumeId) {
    const args = resumeId ? ['--resume', resumeId] : [];
    return args;
  },

  captureResumeId(data) {
    const re = new RegExp(`copilot\\s+--resume\\s+(${UUID_PATTERN})`);
    const match = data.match(re);
    return match ? match[1] : null;
  },

  detectResumeFailed(data) {
    return /No conversation found with session ID|session not found|Session expired|会话.*未找到|会话.*过期|Could not (connect|authenticate)|usage limit/i.test(data);
  },

  getSpawnEnv(baseEnv) {
    return { ...baseEnv };
  }
};
