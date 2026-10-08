const mysql = require('mysql2/promise');
require('dotenv').config();

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ai_employees',
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4'
};

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(DB_CONFIG);
  }
  return pool;
}

async function init() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS employee_summaries (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      session_date DATE NOT NULL,
      role VARCHAR(10) NOT NULL,
      content TEXT NOT NULL,
      tool_calls VARCHAR(500) NULL,
      source VARCHAR(20) DEFAULT 'summary' COMMENT 'summary or recent',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_employee_date (employee_id, session_date),
      INDEX idx_employee_role (employee_id, role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('  [DB] 数据库表初始化完成');
}

async function insertSummaries(employeeId, entries) {
  if (!entries || entries.length === 0) return 0;
  const p = getPool();
  const sql = `INSERT INTO employee_summaries (employee_id, session_date, role, content, source) VALUES ?`;
  const values = entries.map(e => [employeeId, e.date, e.role, e.content, 'summary']);
  const [result] = await p.query(sql, [values]);
  return result.affectedRows;
}

async function insertConversations(employeeId, entries) {
  if (!entries || entries.length === 0) return 0;
  const p = getPool();
  const sql = `INSERT INTO employee_summaries (employee_id, session_date, role, content, tool_calls, source) VALUES ?`;
  const values = entries.map(e => [employeeId, e.date, e.role, e.content, e.toolCalls || null, 'recent']);
  const [result] = await p.query(sql, [values]);
  return result.affectedRows;
}

async function getSummaries(employeeId, limit = 100) {
  const p = getPool();
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 100, 1000));
  const [rows] = await p.query(
    `SELECT id, session_date, role, content, tool_calls, source, created_at
     FROM employee_summaries
     WHERE employee_id = ?
     ORDER BY session_date DESC, id DESC
     LIMIT ?`,
    [employeeId, limitNum]
  );
  return rows;
}

async function getRecentConversations(employeeId, days = 7, limit = 200) {
  const p = getPool();
  const daysNum = Math.max(1, Math.min(parseInt(days) || 7, 90));
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 200, 1000));
  const [rows] = await p.query(
    `SELECT id, session_date, role, content, tool_calls, created_at
     FROM employee_summaries
     WHERE employee_id = ? AND source = 'recent' AND session_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY session_date DESC, id DESC
     LIMIT ?`,
    [employeeId, daysNum, limitNum]
  );
  return rows;
}

async function cleanOldEntries(days = 30) {
  const p = getPool();
  const daysNum = Math.max(1, parseInt(days) || 30);
  const [result] = await p.query(
    `DELETE FROM employee_summaries WHERE session_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    [daysNum]
  );
  if (result.affectedRows > 0) {
    console.log(`  [DB] 已清理 ${result.affectedRows} 条过期记录`);
  }
  return result.affectedRows;
}

async function getRecentHistoryText(employeeId, days = 7, limit = 200) {
  const p = getPool();
  const daysNum = Math.max(1, Math.min(parseInt(days) || 7, 90));
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 200, 1000));
  const [rows] = await p.query(
    `SELECT id, session_date, role, content, tool_calls, source, created_at
     FROM employee_summaries
     WHERE employee_id = ?
       AND session_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY session_date DESC, id DESC
     LIMIT ?`,
    [employeeId, daysNum, limitNum]
  );
  if (!rows.length) return null;

  const recentConvs = rows.filter(r => r.source === 'recent').reverse();
  const summaries = rows.filter(r => r.source === 'summary').reverse();

  let text = `# 对话历史 (${employeeId}) — DB 摘要\n\n`;
  text += `> 生成时间: ${new Date().toISOString()}\n`;
  text += `> 数据来源: MySQL employee_summaries 表\n\n`;

  if (summaries.length > 0) {
    text += `## 历史摘要 (${summaries.length} 条)\n\n`;
    let currentDate = '';
    for (const row of summaries) {
      const d = new Date(row.session_date).toLocaleDateString('sv-SE');
      if (d !== currentDate) {
        currentDate = d;
        text += `### ${d}\n\n`;
      }
      if (row.role === 'user') {
        text += `**用户**: ${row.content}\n\n`;
      } else {
        text += `**AI**: ${row.content}\n\n`;
      }
    }
  }

  if (recentConvs.length > 0) {
    text += `## 近期对话 (${recentConvs.length} 条)\n\n`;
    for (const row of recentConvs) {
      if (row.role === 'user') {
        text += `### 用户提问\n${row.content}\n\n`;
      } else {
        text += `### AI 回复\n${row.content}\n`;
        if (row.tool_calls) {
          text += `${row.tool_calls}\n`;
        }
        text += '\n';
      }
    }
  }

  // 控制总大小 < 30KB
  const maxSize = 30 * 1024;
  if (text.length > maxSize) text = text.slice(-maxSize);

  return text;
}

async function getStats() {
  const p = getPool();
  const [rows] = await p.query(
    `SELECT employee_id, source, COUNT(*) as count
     FROM employee_summaries
     GROUP BY employee_id, source
     ORDER BY employee_id, source`
  );
  return rows;
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { init, insertSummaries, insertConversations, getSummaries, getRecentConversations, cleanOldEntries, getStats, getRecentHistoryText, close };
