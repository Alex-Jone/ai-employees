// cc-connect CLI Provider (长驻进程，桥接外部聊天平台到本地 AI 代理)
module.exports = {
  name: 'cc-connect',
  displayName: 'CC Connect',
  command: 'cc-connect',
  configFileName: null,

  getArgs(employee, resumeId) {
    return ['--force'];
  },

  captureResumeId(data) {
    return null;
  },

  detectResumeFailed(data) {
    return false;
  },

  getSpawnEnv(baseEnv) {
    return { ...baseEnv };
  }
};
