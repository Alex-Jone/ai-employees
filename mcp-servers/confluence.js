#!/usr/bin/env node

/**
 * Confluence MCP Server
 * 通过 Personal Access Token 读取 Confluence 页面 (支持自建 Confluence)
 * 协议: MCP (Model Context Protocol) over stdio
 *
 * 需要在 .env 中配置:
 *   CONFLUENCE_BASE_URL  — 例如 https://confluence.example.com
 *   CONFLUENCE_TOKEN     — Personal Access Token
 */

const https = require('https');
const http = require('http');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// 加载 .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  });
}

const BASE_URL = process.env.CONFLUENCE_BASE_URL;
const TOKEN = process.env.CONFLUENCE_TOKEN;

if (!BASE_URL || !TOKEN) {
  process.stderr.write('ERROR: CONFLUENCE_BASE_URL and CONFLUENCE_TOKEN must be set in .env\n');
  process.exit(1);
}

// ---- HTML to Markdown 简易转换 ----
function htmlToMarkdown(html) {
  if (!html) return '';
  let md = html;
  // 移除 script/style
  md = md.replace(/<script[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[\s\S]*?<\/style>/gi, '');
  // 标题
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');
  // 粗体/斜体
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  // 链接
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // 代码块
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  // 列表
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<\/?[uo]l[^>]*>/gi, '\n');
  // 表格 (简单处理)
  md = md.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = [];
    row.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, (_, cell) => {
      cells.push(cell.trim());
    });
    return '| ' + cells.join(' | ') + ' |\n';
  });
  md = md.replace(/<\/?table[^>]*>/gi, '\n');
  md = md.replace(/<\/?thead[^>]*>/gi, '');
  md = md.replace(/<\/?tbody[^>]*>/gi, '');
  // 段落/换行
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  md = md.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n');
  // 移除剩余标签
  md = md.replace(/<[^>]+>/g, '');
  // HTML 实体
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, ' ');
  // 清理多余空行
  md = md.replace(/\n{3,}/g, '\n\n');
  return md.trim();
}

// ---- HTTP 请求 ----
function requestJSON(urlStr, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';
    const req = mod.request(url, {
      method,
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function fetchJSON(urlStr) {
  return requestJSON(urlStr, 'GET');
}

// ---- Markdown to Confluence Storage HTML 简易转换 ----
function markdownToStorage(md) {
  if (!md) return '';
  let html = md;
  // 标题
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  // 代码块
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${lang || 'text'}</ac:parameter><ac:plain-text-body><![CDATA[${code.trimEnd()}]]></ac:plain-text-body></ac:structured-macro>`;
  });
  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 粗体/斜体
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // 链接
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // 无序列表
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // 段落（非标签开头的行）
  html = html.replace(/^(?!<[a-zA-Z])(.+)$/gm, '<p>$1</p>');
  // 清理空段落
  html = html.replace(/<p>\s*<\/p>/g, '');
  return html;
}

// ---- 从 URL 提取 pageId ----
function extractPageId(input) {
  // 支持纯数字
  if (/^\d+$/.test(input.trim())) return input.trim();
  // 从 URL 提取 pageId 参数
  const match = input.match(/pageId=(\d+)/);
  if (match) return match[1];
  return null;
}

// ---- MCP 协议处理 ----
const TOOLS = [
  {
    name: 'confluence_read',
    description: '读取 Confluence 页面内容。支持传入完整 URL 或 pageId。返回页面标题和 Markdown 格式的正文。',
    inputSchema: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          description: '页面 URL（包含 pageId 参数）或页面 ID（纯数字）',
        },
      },
      required: ['page'],
    },
  },
  {
    name: 'confluence_search',
    description: '搜索 Confluence 页面。返回匹配的页面列表（标题、ID、链接）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词（CQL 查询）',
        },
        limit: {
          type: 'number',
          description: '返回结果数量上限，默认 10',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'confluence_create',
    description: '在 Confluence 中创建新页面。需要指定空间 key、标题和正文内容（Markdown 格式，会自动转为 Confluence 格式）。可选指定父页面 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        spaceKey: {
          type: 'string',
          description: '空间 key（如 "INF"、"BIGDATA"），可通过 confluence_read 已有页面获取',
        },
        title: {
          type: 'string',
          description: '页面标题',
        },
        content: {
          type: 'string',
          description: '页面正文内容（Markdown 格式）',
        },
        parentId: {
          type: 'string',
          description: '父页面 ID（可选，不填则创建在空间根目录下）',
        },
      },
      required: ['spaceKey', 'title', 'content'],
    },
  },
  {
    name: 'confluence_update',
    description: '更新 Confluence 已有页面的内容。需要提供页面 URL 或 pageId，以及新的标题和/或正文内容（Markdown 格式）。会自动获取当前版本号并递增。',
    inputSchema: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          description: '页面 URL 或 pageId',
        },
        title: {
          type: 'string',
          description: '新标题（可选，不填则保持原标题）',
        },
        content: {
          type: 'string',
          description: '新的页面正文内容（Markdown 格式，会替换整个页面内容）',
        },
      },
      required: ['page', 'content'],
    },
  },
  {
    name: 'confluence_comment',
    description: '在 Confluence 页面下添加评论。',
    inputSchema: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          description: '页面 URL 或 pageId',
        },
        content: {
          type: 'string',
          description: '评论内容（Markdown 格式）',
        },
      },
      required: ['page', 'content'],
    },
  },
];

let requestId = 0;

function makeResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

function makeError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n';
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return makeResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'confluence', version: '1.0.0' },
      });

    case 'notifications/initialized':
      return null; // 无需响应

    case 'tools/list':
      return makeResponse(id, { tools: TOOLS });

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === 'confluence_read') {
        const pageId = extractPageId(args.page || '');
        if (!pageId) {
          return makeResponse(id, {
            content: [{ type: 'text', text: '错误：无法从输入中提取 pageId。请提供完整 URL 或纯数字 ID。' }],
            isError: true,
          });
        }
        try {
          const apiUrl = `${BASE_URL}/rest/api/content/${pageId}?expand=body.storage,version,space`;
          const data = await fetchJSON(apiUrl);
          const title = data.title || '(无标题)';
          const space = data.space?.name || '';
          const version = data.version?.number || '';
          const bodyHtml = data.body?.storage?.value || '';
          const bodyMd = htmlToMarkdown(bodyHtml);
          const pageUrl = `${BASE_URL}/pages/viewpage.action?pageId=${pageId}`;
          const text = `# ${title}\n\n**空间**: ${space} | **版本**: ${version} | **链接**: ${pageUrl}\n\n---\n\n${bodyMd}`;
          return makeResponse(id, {
            content: [{ type: 'text', text }],
          });
        } catch (e) {
          return makeResponse(id, {
            content: [{ type: 'text', text: `读取页面失败: ${e.message}` }],
            isError: true,
          });
        }
      }

      if (toolName === 'confluence_search') {
        const query = args.query || '';
        const limit = args.limit || 10;
        try {
          const cql = encodeURIComponent(`type=page AND (title~"${query}" OR text~"${query}")`);
          const apiUrl = `${BASE_URL}/rest/api/content/search?cql=${cql}&limit=${limit}`;
          const data = await fetchJSON(apiUrl);
          const results = (data.results || []).map(r => ({
            id: r.id,
            title: r.title,
            url: `${BASE_URL}/pages/viewpage.action?pageId=${r.id}`,
            space: r.space?.name || '',
          }));
          if (results.length === 0) {
            return makeResponse(id, {
              content: [{ type: 'text', text: `未找到与 "${query}" 相关的页面。` }],
            });
          }
          const text = results.map((r, i) =>
            `${i + 1}. **${r.title}** (ID: ${r.id})\n   空间: ${r.space} | ${r.url}`
          ).join('\n\n');
          return makeResponse(id, {
            content: [{ type: 'text', text: `找到 ${results.length} 个结果：\n\n${text}` }],
          });
        } catch (e) {
          return makeResponse(id, {
            content: [{ type: 'text', text: `搜索失败: ${e.message}` }],
            isError: true,
          });
        }
      }

      if (toolName === 'confluence_create') {
        const { spaceKey, title, content, parentId } = args;
        if (!spaceKey || !title || !content) {
          return makeResponse(id, {
            content: [{ type: 'text', text: '错误：spaceKey、title、content 均为必填项。' }],
            isError: true,
          });
        }
        try {
          const body = {
            type: 'page',
            title,
            space: { key: spaceKey },
            body: { storage: { value: markdownToStorage(content), representation: 'storage' } },
          };
          if (parentId) {
            body.ancestors = [{ id: parentId }];
          }
          const apiUrl = `${BASE_URL}/rest/api/content`;
          const data = await requestJSON(apiUrl, 'POST', body);
          const pageUrl = `${BASE_URL}/pages/viewpage.action?pageId=${data.id}`;
          return makeResponse(id, {
            content: [{ type: 'text', text: `页面创建成功！\n\n**标题**: ${data.title}\n**ID**: ${data.id}\n**链接**: ${pageUrl}` }],
          });
        } catch (e) {
          return makeResponse(id, {
            content: [{ type: 'text', text: `创建页面失败: ${e.message}` }],
            isError: true,
          });
        }
      }

      if (toolName === 'confluence_update') {
        const pageId = extractPageId(args.page || '');
        if (!pageId) {
          return makeResponse(id, {
            content: [{ type: 'text', text: '错误：无法从输入中提取 pageId。' }],
            isError: true,
          });
        }
        try {
          // 先获取当前页面信息（版本号 + 标题）
          const current = await fetchJSON(`${BASE_URL}/rest/api/content/${pageId}?expand=version,space`);
          const newVersion = (current.version?.number || 0) + 1;
          const newTitle = args.title || current.title;
          const body = {
            type: 'page',
            title: newTitle,
            space: { key: current.space?.key },
            body: { storage: { value: markdownToStorage(args.content), representation: 'storage' } },
            version: { number: newVersion },
          };
          const apiUrl = `${BASE_URL}/rest/api/content/${pageId}`;
          const data = await requestJSON(apiUrl, 'PUT', body);
          const pageUrl = `${BASE_URL}/pages/viewpage.action?pageId=${pageId}`;
          return makeResponse(id, {
            content: [{ type: 'text', text: `页面更新成功！\n\n**标题**: ${data.title}\n**版本**: ${newVersion}\n**链接**: ${pageUrl}` }],
          });
        } catch (e) {
          return makeResponse(id, {
            content: [{ type: 'text', text: `更新页面失败: ${e.message}` }],
            isError: true,
          });
        }
      }

      if (toolName === 'confluence_comment') {
        const pageId = extractPageId(args.page || '');
        if (!pageId) {
          return makeResponse(id, {
            content: [{ type: 'text', text: '错误：无法从输入中提取 pageId。' }],
            isError: true,
          });
        }
        try {
          const body = {
            type: 'comment',
            container: { id: pageId, type: 'page' },
            body: { storage: { value: markdownToStorage(args.content), representation: 'storage' } },
          };
          const apiUrl = `${BASE_URL}/rest/api/content`;
          const data = await requestJSON(apiUrl, 'POST', body);
          return makeResponse(id, {
            content: [{ type: 'text', text: `评论添加成功！\n\n**评论 ID**: ${data.id}\n**页面**: ${BASE_URL}/pages/viewpage.action?pageId=${pageId}` }],
          });
        } catch (e) {
          return makeResponse(id, {
            content: [{ type: 'text', text: `添加评论失败: ${e.message}` }],
            isError: true,
          });
        }
      }

      return makeError(id, -32601, `Unknown tool: ${toolName}`);
    }

    default:
      if (id !== undefined) {
        return makeError(id, -32601, `Unknown method: ${method}`);
      }
      return null; // 通知类消息不需要响应
  }
}

// ---- stdio 通信 ----
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    const response = await handleRequest(msg);
    if (response) process.stdout.write(response);
  } catch (e) {
    process.stderr.write(`Parse error: ${e.message}\n`);
    process.stdout.write(makeError(null, -32700, 'Parse error') + '\n');
  }
});

process.stderr.write('Confluence MCP Server started\n');
