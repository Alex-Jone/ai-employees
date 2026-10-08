const claude = require('./claude');
const copilot = require('./copilot');
const deepseek = require('./deepseek');
const ccConnect = require('./cc-connect');

const providers = { claude, copilot, deepseek, 'cc-connect': ccConnect };

/**
 * 根据员工配置获取对应的 CLI Provider
 * @param {Object} employee - 员工配置对象
 * @returns {Object} provider 实例
 */
function getProvider(employee) {
  const name = employee.provider || 'claude';
  const provider = providers[name];
  if (!provider) {
    throw new Error(`未知 Provider: ${name}，可选值: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

module.exports = { getProvider, providers };
