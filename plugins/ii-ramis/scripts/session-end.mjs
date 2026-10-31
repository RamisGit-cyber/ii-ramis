// SessionEnd: короткий итог сессии в ~/.ii-ramis/progress.jsonl.
// В итог НЕ попадают: код, содержимое файлов, тексты команд, пути к файлам, тексты сообщений ученика.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROGRESS_FILE, ensureDataDir, loadConfig, readStdinJson, redact } from './lib.mjs';

const STUCK_THRESHOLD = 3;
const BASH_CATEGORIES = [
  ['git', /\bgit\s/],
  ['install', /\b(npm|pnpm|yarn|pip3?|brew|winget|npx)\s+(i|install|add|-y|create)?/],
  ['dev-server', /\b(npm|pnpm|yarn)\s+(run\s+)?dev\b|\bnext\s+dev\b|\bvite\b|http\.server|\bserve\b/],
  ['deploy', /\bvercel\b|\bgh\s+(repo|pr)\b/],
  ['test', /\b(playwright|jest|vitest|pytest)\b/],
  ['database', /\bsupabase\b|\bpsql\b|\bprisma\b/],
];

function messageBlocks(entry) {
  const content = entry?.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map((part) => part.text || '').join(' ');
  return '';
}

function firstMeaningfulLine(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const errorLine = lines.find((line) => /error|ошибка|failed|not found|denied|cannot|exception|exit code/i.test(line));
  return errorLine || lines[0] || 'unknown';
}

function toolLabel(name) {
  if (name.startsWith('mcp__')) return `mcp:${name.split('__')[1]}`;
  return name;
}

function summarize(transcriptPath, config, input) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  const tools = {};
  const categories = new Set();
  const toolNameById = new Map();
  const errorCounts = new Map();
  const exts = {};
  const editedFiles = new Set();
  let prompts = 0;
  let askedUser = 0;
  let selfDone = 0;
  let first = null;
  let last = null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // последняя строка могла записаться не до конца
    }
    if (entry.timestamp) {
      const time = Date.parse(entry.timestamp);
      if (!Number.isNaN(time)) {
        first = first === null ? time : Math.min(first, time);
        last = last === null ? time : Math.max(last, time);
      }
    }
    const blocks = messageBlocks(entry);
    if (entry.type === 'user' && !entry.isMeta && blocks.some((b) => b.type === 'text') && !blocks.some((b) => b.type === 'tool_result')) {
      prompts += 1;
    }
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        const label = toolLabel(block.name);
        tools[label] = (tools[label] || 0) + 1;
        toolNameById.set(block.id, label);
        if (label === 'AskUserQuestion') askedUser += 1;
        else selfDone += 1;
        const target = block.input?.file_path || block.input?.path;
        if (['Edit', 'Write', 'NotebookEdit'].includes(label) && target) {
          editedFiles.add(String(target));
          const ext = path.extname(String(target)).toLowerCase() || '(без расширения)';
          exts[ext] = (exts[ext] || 0) + 1;
        }
        if (label === 'Bash' || label === 'PowerShell') {
          const command = String(block.input?.command || '');
          for (const [category, pattern] of BASH_CATEGORIES) {
            if (pattern.test(command)) categories.add(category);
          }
        }
        if (label.startsWith('mcp:playwright')) categories.add('browser-check');
      } else if (block.type === 'tool_result' && block.is_error) {
        const label = toolNameById.get(block.tool_use_id) || 'tool';
        const signature = `${label}: ${redact(firstMeaningfulLine(resultText(block)))}`;
        errorCounts.set(signature, (errorCounts.get(signature) || 0) + 1);
      }
    }
  }

  const errors = [...errorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([signature, count]) => ({ what: signature, count }));
  const stuckEntry = errors.find((item) => item.count >= STUCK_THRESHOLD);

  return {
    v: 1,
    ts: new Date().toISOString(),
    session_id: input.session_id || null,
    student_id: config.student_id,
    ...(config.share && config.student_name ? { student_name: config.student_name } : {}),
    os: process.platform,
    lesson: config.lesson ?? null,
    project_dir_name: path.basename(input.cwd || ''),
    end_reason: input.reason || null,
    duration_min: first !== null && last !== null ? Math.round((last - first) / 60000) : null,
    prompts,
    tools,
    categories: [...categories],
    files_edited: editedFiles.size,
    file_types: exts,
    errors,
    stuck: Boolean(stuckEntry),
    stuck_on: stuckEntry ? stuckEntry.what : null,
    asked_user: askedUser,
    self_done: selfDone,
  };
}

function sendIfAllowed(record, config) {
  const url = process.env.IIRAMIS_REPORT_URL || config.report_url;
  if (config.share !== true || !url) return;
  const headers = ['-H', 'content-type: application/json'];
  if (process.env.IIRAMIS_REPORT_TOKEN) headers.push('-H', `authorization: Bearer ${process.env.IIRAMIS_REPORT_TOKEN}`);
  // Молчаливый отказ: нет сети, нет curl, сервер не ответил за 5 секунд — ученик ничего не видит.
  spawnSync('curl', ['-s', '-o', os.devNull, '-m', '5', '-X', 'POST', ...headers, '--data-binary', '@-', url], {
    input: JSON.stringify(record),
    timeout: 6000,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });
}

function main() {
  const input = readStdinJson();
  if (!input.transcript_path || !fs.existsSync(input.transcript_path)) return;
  const config = loadConfig();
  const record = summarize(input.transcript_path, config, input);
  if (record.prompts === 0 && Object.keys(record.tools).length === 0) return; // пустая сессия
  ensureDataDir();
  fs.appendFileSync(PROGRESS_FILE, JSON.stringify(record) + '\n');
  sendIfAllowed(record, config);
}

try {
  main();
} catch (error) {
  console.error(`ii-ramis session-end: ${error.message}`);
}
process.exit(0);
