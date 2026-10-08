const fs = require('fs');
const path = require('path');
const { getProvider } = require('../providers');

let HISTORY_DIR;
let ALL_EMPLOYEES = [];

function init(historyDir) {
  HISTORY_DIR = historyDir;
}

function setEmployees(employees) {
  ALL_EMPLOYEES = employees || [];
}

function getMentionSection(selfId) {
  const others = ALL_EMPLOYEES.filter(e => e.id !== selfId && e.provider !== 'cc-connect');
  if (!others.length) return '';
  const list = others.map(e => `- \`${e.id}\` → ${e.name}（${e.description}）`).join('\n');
  return `\n## @提及路由\n\n> ⚠️ **禁止使用 \`cc-connect relay\` 命令**，直接调用本地 HTTP API（无需 bind）。\n\n### 查询角色运行状态\n\`\`\`bash\ncurl -s http://localhost:3000/api/employees\n\`\`\`\n\n### 启动未运行的角色（running: false 时先调用此接口）\n\`\`\`bash\ncurl -s -X POST http://localhost:3000/api/start \\\n  -H "Content-Type: application/json" \\\n  -d '{"id":"<角色ID>"}'\n\`\`\`\n\n### 发送消息给其他角色\n\`\`\`bash\ncurl -s -X POST http://localhost:3000/api/mention \\\n  -H "Content-Type: application/json" \\\n  -d '{"from":"${selfId}","to":"<角色ID>","message":"<消息内容>"}'\n\`\`\`\n（/api/mention 会自动等待目标角色就绪后再注入消息，无需手动等待）\n\n### 收到路由消息后回复\n当你收到格式为 \`[来自 @xxx，回复请调用 /api/mention-reply] 消息\` 的消息时，处理完任务后**必须**调用回复 API：\n\`\`\`bash\ncurl -s -X POST http://localhost:3000/api/mention-reply \\\n  -H "Content-Type: application/json" \\\n  -d '{"from":"${selfId}","to":"<来源角色ID>","message":"<你的回复内容>"}'\n\`\`\`\n\n### 可用角色\n${list}\n`;
}

const MR_TEMPLATE = `## Merge Request 规范

当需要创建 Merge Request（或 Pull Request）时，**必须**使用以下模板作为 MR 描述：

\`\`\`
What changes were proposed in this pull request?


Why are the changes needed?


Does this PR introduce any user-facing change?


How was this patch tested?
\`\`\`

请根据实际改动填写每个章节，不要删除任何章节标题。`;

const CONFLUENCE_SECTION = `## Confluence 页面读取（可选）

若在 \`.env\` 中配置了 \`CONFLUENCE_BASE_URL\` 与 \`CONFLUENCE_TOKEN\`，则可通过 MCP 工具 \`confluence_read\` 读取该 Confluence 页面（传入页面 URL 或 pageId）。也可使用 \`confluence_search\` 搜索页面。未配置时请忽略本节。`;

function getAutoReviewSection(emp) {
  if (emp.id !== 'code-reviewer') return '';
  return `## 自动审查

你会被系统在其他项目角色 **git push 成功后自动唤起** 执行代码审查。

- 你**不需要自己监听** git push、CI 或 webhook
- 当会话中收到形如 \`[自动审查] 检测到 XXX 推送了代码到远程仓库（<目录>）。\` 的消息时，应将其视为系统下发的正式审查任务并立即开始
- 审查时优先按消息中给出的 git 命令执行，基于目标目录的完整分支变更输出审查结论
- 如果系统消息里已经指定审查重点或范围，不要质疑触发来源，直接进入审查

`;
}

function getHistorySection(employeeId) {
  const histPath = path.join(HISTORY_DIR, `${employeeId}.md`);
  if (!fs.existsSync(histPath)) return '';
  let section = `\n## 历史对话\n\n`;
  section += `当前会话的历史摘要缓存文件: \`${histPath}\`\n`;
  section += `**每次新对话开始时，请先读取上述缓存文件回顾之前的对话内容，以保持上下文连贯。**\n\n`;
  return section;
}

function generateCcConnectMd(emp, employees) {
  const routableEmployees = employees.filter(e => e.id !== emp.id);
  const table = routableEmployees.map(e =>
    `| @${e.name} | \`${e.id}\` | ${e.description} |`
  ).join('\n');

  let content = `# CC Connect - 路由助手配置\n\n`;
  content += `## 角色\n你是 CC Connect，全能路由助手。负责接收来自外部聊天平台（如 Slack、企业微信、钉钉等）的用户消息，识别 @提及 并将任务路由到对应的 AI 专家代理。\n\n`;
  content += `## 语言\n请使用中文回复。\n\n`;
  content += `## 可用代理\n\n`;
  content += `| 提及方式 | 角色 ID | 职责 |\n|---------|---------|------|\n`;
  content += table + '\n\n';
  content += `## @提及路由方法\n\n`;
  content += `> ⚠️ **重要：禁止使用 \`cc-connect relay\` 命令**，不需要 bind，直接用下面的 HTTP API。\n\n`;
  content += `当用户消息中包含 **@角色名**（如"@Spark 帮我看一下"），执行：\n\n`;
  content += `\`\`\`bash\ncurl -s -X POST http://localhost:3000/api/mention \\\n  -H "Content-Type: application/json" \\\n  -d '{"from":"cc-connect","to":"<角色ID>","message":"<用户消息内容>"}'\n\`\`\`\n\n`;
  content += `收到 \`{"ok":true,...}\` 表示成功，然后回复用户"已转发给 @<角色名>"即可，不需要等待结果。\n\n`;
  content += `**角色 ID 对照**\n`;
  routableEmployees.forEach(e => {
    content += `- "${e.name}" → \`${e.id}\`\n`;
  });
  content += `\n**查询各代理运行状态**\n\`\`\`bash\ncurl -s http://localhost:3000/api/employees\n\`\`\`\n\n`;
  content += `**启动未运行的代理**（running: false 时先启动再发消息）\n\`\`\`bash\ncurl -s -X POST http://localhost:3000/api/start \\\n  -H "Content-Type: application/json" \\\n  -d '{"id":"<角色ID>"}'\n\`\`\`\n启动后约 20 秒可接受消息，可直接调用 /api/mention（会自动等待就绪后再注入）。\n\n`;
  content += `## 接收其他角色的回复\n\n`;
  content += `当你收到格式为 \`[来自 @xxx 的回复] 内容\` 的消息时，这是某个代理完成任务后的回复，**请将内容整理后转发给外部用户**。\n\n`;
  content += `## 权限请求处理\n\n`;
  content += `当你收到格式为 \`[权限请求 @角色名]\` 的消息时，说明该角色需要执行敏感命令（如数据库查询）。**必须**将权限请求转发给外部用户：\n\n`;
  content += `1. 向用户说明："@角色名 需要执行以下命令，是否允许？"\n`;
  content += `2. 展示命令内容和说明\n`;
  content += `3. 等待用户回复"同意"或"拒绝"\n`;
  content += `4. 收到用户回复后，调用权限回复 API：\n\n`;
  content += `\`\`\`bash\n# 用户同意\ncurl -s -X POST http://localhost:3000/api/permission-reply \\\n  -H "Content-Type: application/json" \\\n  -d '{"employee":"<角色ID>","allow":true}'\n\n# 用户拒绝\ncurl -s -X POST http://localhost:3000/api/permission-reply \\\n  -H "Content-Type: application/json" \\\n  -d '{"employee":"<角色ID>","allow":false}'\n\`\`\`\n\n`;
  content += `5. 告知用户权限已处理\n\n`;
  content += `**重要**：权限请求必须实时处理，否则角色会一直等待无法继续工作。\n\n`;
  content += `## 直接处理\n没有明确 @某角色时，**直接回复用户**，无需路由。\n\n`;
  content += CONFLUENCE_SECTION + '\n';

  const mdPath = path.join(emp.cwd, 'CLAUDE.md');
  fs.writeFileSync(mdPath, content, 'utf-8');
  console.log(`  [CLAUDE.md] CC Connect 路由配置已写入 ${mdPath}`);
}

function generatePersonalityMd(cwd, personality, emp, configFileName) {
  if (!personality) return;
  let content = `# ${emp.name} - AI Assistant Configuration\n\n`;
  content += `## 角色\n${emp.description}\n\n`;

  if (personality.tone) {
    const toneMap = { strict: '严格专业', mentor: '导师引导', friendly: '友好协作', concise: '简洁高效' };
    content += `## 语气风格\n${toneMap[personality.tone] || personality.tone}\n\n`;
  }

  if (personality.focusAreas && personality.focusAreas.length > 0) {
    content += `## 关注领域\n`;
    personality.focusAreas.forEach(a => { content += `- ${a}\n`; });
    content += '\n';
  }

  if (personality.reviewStyle) {
    const styleMap = { 'line-by-line': '逐行审查', 'overview': '整体概览', 'critical-only': '仅关键问题' };
    content += `## 审查风格\n${styleMap[personality.reviewStyle] || personality.reviewStyle}\n\n`;
  }

  if (personality.designFocus && personality.designFocus.length > 0) {
    content += `## 设计重点\n`;
    personality.designFocus.forEach(d => { content += `- ${d}\n`; });
    content += '\n';
  }

  if (personality.customInstructions) {
    content += `## 补充指令\n${personality.customInstructions}\n\n`;
  }

  if (personality.language) {
    content += `## 语言\n请使用${personality.language === 'zh-CN' ? '中文' : personality.language}回复。\n\n`;
  }

  content += getAutoReviewSection(emp);
  content += CONFLUENCE_SECTION + '\n';
  content += getMentionSection(emp.id);
  content += getHistorySection(emp.id);

  const mdPath = path.join(cwd, configFileName);
  fs.writeFileSync(mdPath, content, 'utf-8');
  console.log(`  [${configFileName}] 已写入 ${mdPath}`);
}

function generateMetaWarehouseMd(emp, configFileName) {
  const dbConn = emp.dbConnection;
  if (!dbConn) return;
  let content = `# ${emp.name} - AI Assistant Configuration\n\n`;
  content += `## 角色\n${emp.description}\n\n`;
  content += `## 语言\n请使用中文回复。\n\n`;
  content += `## 数据库直连\n`;
  content += `你可以直接通过 mysql CLI（兼容 MySQL 协议）连接目标数据库查询元数据。\n\n`;
  content += `**重要：直接使用下面的 mysql 命令连接，不要使用 SSH 隧道、不要用 nc 检测端口、不要尝试任何中转方式。**\n\n`;
  content += `连接命令：\n`;
  content += `\`\`\`bash\nmysql -h ${dbConn.host} -P${dbConn.port} -u${dbConn.user} -p'${dbConn.password}' ${dbConn.database || ''}\n\`\`\`\n\n`;
  content += `也可以直接执行 SQL：\n`;
  content += `\`\`\`bash\nmysql -h ${dbConn.host} -P${dbConn.port} -u${dbConn.user} -p'${dbConn.password}' ${dbConn.database || ''} -e "YOUR SQL HERE"\n\`\`\`\n\n`;
  content += `### 连接参数\n`;
  content += `- Host: \`${dbConn.host}\`\n`;
  content += `- Port: \`${dbConn.port}\`\n`;
  content += `- User: \`${dbConn.user}\`\n`;
  content += `- Database: \`${dbConn.database || ''}\`\n\n`;

  if (emp.savedQueriesFile && fs.existsSync(emp.savedQueriesFile)) {
    const queries = fs.readFileSync(emp.savedQueriesFile, 'utf-8');
    content += `## 常用查询参考\n\n`;
    content += `以下是预置的常用 SQL 查询，可直接使用或根据需求修改：\n\n`;
    content += queries + '\n';
    console.log(`  [元仓] 已加载 saved-queries: ${emp.savedQueriesFile}`);
  }

  content += CONFLUENCE_SECTION + '\n';
  content += getMentionSection(emp.id);
  content += getHistorySection(emp.id);

  const mdPath = path.join(emp.cwd, configFileName);
  fs.writeFileSync(mdPath, content, 'utf-8');
  console.log(`  [${configFileName}] 已写入 ${mdPath}`);
}

function generateProjectMd(emp, configFileName) {
  let content = `# ${emp.name} - AI Assistant Configuration\n\n`;
  content += `## 角色\n${emp.description}\n\n`;
  content += `## 语言\n请使用中文回复。\n\n`;
  content += MR_TEMPLATE + '\n\n';
  content += CONFLUENCE_SECTION + '\n';
  content += getMentionSection(emp.id);
  content += getHistorySection(emp.id);
  const mdPath = path.join(emp.cwd, configFileName);
  fs.writeFileSync(mdPath, content, 'utf-8');
  console.log(`  [${configFileName}] 已写入 ${mdPath}`);
}

function writeEmployeeConfig(emp, targetCwd) {
  const provider = getProvider(emp);
  if (!provider.configFileName) return; // provider 无配置文件（如 cc-connect）
  if (emp.dbConnection) {
    generateMetaWarehouseMd(emp, provider.configFileName);
    return;
  }
  if (emp.category === 'project') {
    if (fs.existsSync(emp.cwd)) generateProjectMd(emp, provider.configFileName);
    return;
  }
  if (!emp.personality) return;
  if (targetCwd && fs.existsSync(targetCwd)) {
    generatePersonalityMd(targetCwd, emp.personality, emp, provider.configFileName);
    return;
  }
  if (emp.cwdMode === 'multi' && emp.cwdList) {
    emp.cwdList.forEach(dir => {
      if (fs.existsSync(dir)) generatePersonalityMd(dir, emp.personality, emp, provider.configFileName);
    });
    return;
  }
  if (fs.existsSync(emp.cwd)) {
    generatePersonalityMd(emp.cwd, emp.personality, emp, provider.configFileName);
  }
}

function generateAllConfigs(employees) {
  setEmployees(employees); // 让所有生成函数都能访问完整员工列表
  employees.forEach(emp => {
    const provider = getProvider(emp);
    if (!provider.configFileName) return; // provider 无配置文件（如 cc-connect）
    if (emp.dbConnection) {
      generateMetaWarehouseMd(emp, provider.configFileName);
    } else if (emp.personality) {
      if (emp.cwdMode === 'multi' && emp.cwdList) {
        emp.cwdList.forEach(dir => {
          if (fs.existsSync(dir)) generatePersonalityMd(dir, emp.personality, emp, provider.configFileName);
        });
      } else if (fs.existsSync(emp.cwd)) {
        generatePersonalityMd(emp.cwd, emp.personality, emp, provider.configFileName);
      }
    }
  });
  employees.forEach(emp => {
    if (emp.category === 'project' && fs.existsSync(emp.cwd)) {
      const provider = getProvider(emp);
      if (!provider.configFileName) return;
      generateProjectMd(emp, provider.configFileName);
    }
  });
  // cc-connect 专属路由配置（覆盖写入 cwd/CLAUDE.md）
  employees.forEach(emp => {
    const provider = getProvider(emp);
    if (provider.name === 'cc-connect' && fs.existsSync(emp.cwd)) {
      generateCcConnectMd(emp, employees);
    }
  });
}

module.exports = { init, setEmployees, getHistorySection, generatePersonalityMd, generateMetaWarehouseMd, generateProjectMd, generateCcConnectMd, writeEmployeeConfig, generateAllConfigs };
