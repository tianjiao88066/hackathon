#!/usr/bin/env node
'use strict';

/**
 * ECC Agent Optimization Platform - Web UI Server
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ECC_ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ECC_ROOT, 'ui');
const PORT = process.env.PORT || 3847;

// ─── Pricing (per million tokens) ────────────────────────────────────────────
const MODEL_PRICING = {
  opus:   { input: 15.00, output: 75.00, label: 'Claude Opus 4.6',   id: 'claude-opus-4-6' },
  sonnet: { input:  3.00, output: 15.00, label: 'Claude Sonnet 4.6', id: 'claude-sonnet-4-6' },
  haiku:  { input:  0.80, output:  4.00, label: 'Claude Haiku 4.5',  id: 'claude-haiku-4-5-20251001' },
};

// ─── Frontmatter Parser ───────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (value.startsWith('[')) {
      try { value = JSON.parse(value); } catch (_) { /* keep string */ }
    }
    meta[key] = value;
  }
  return { meta, body: content.slice(match[0].length).trim() };
}

// ─── Data Loaders ─────────────────────────────────────────────────────────────

function loadAgents() {
  const dir = path.join(ECC_ROOT, 'agents');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(file => {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const { meta, body } = parseFrontmatter(content);
      const firstPara = body.split(/\n\n/)[0].replace(/^#+[^\n]*\n/, '').trim();
      return {
        id: path.basename(file, '.md'),
        name: meta.name || path.basename(file, '.md'),
        description: meta.description || firstPara.slice(0, 200),
        tools: Array.isArray(meta.tools) ? meta.tools : [],
        model: meta.model || 'sonnet',
        preview: firstPara.slice(0, 300),
        fullContent: body,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loadSkills() {
  const dir = path.join(ECC_ROOT, 'skills');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const skillFile = path.join(dir, d.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) return null;
      const content = fs.readFileSync(skillFile, 'utf-8');
      const { meta, body } = parseFrontmatter(content);
      const firstPara = body.split(/\n\n/)[0].replace(/^#+[^\n]*\n/, '').trim();
      return {
        id: d.name,
        name: meta.name || d.name,
        description: meta.description || firstPara.slice(0, 200),
        origin: meta.origin || '',
        preview: firstPara.slice(0, 300),
        category: deriveCategory(d.name),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function loadCommands() {
  const dir = path.join(ECC_ROOT, 'commands');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(file => {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const { meta, body } = parseFrontmatter(content);
      const firstLine = body.split('\n').find(l => l.trim() && !l.startsWith('#')) || '';
      return {
        id: path.basename(file, '.md'),
        name: `/${path.basename(file, '.md')}`,
        description: meta.description || firstLine.trim().slice(0, 200),
        preview: body.slice(0, 300),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function loadStats() {
  const agents = fs.readdirSync(path.join(ECC_ROOT, 'agents')).filter(f => f.endsWith('.md'));
  const skillsDirs = fs.readdirSync(path.join(ECC_ROOT, 'skills'), { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(ECC_ROOT, 'skills', d.name, 'SKILL.md')));
  const commands = fs.readdirSync(path.join(ECC_ROOT, 'commands')).filter(f => f.endsWith('.md'));
  const rulesDirs = fs.readdirSync(path.join(ECC_ROOT, 'rules'), { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'common');
  return {
    agents: agents.length,
    skills: skillsDirs.length,
    commands: commands.length,
    languages: rulesDirs.length,
    version: JSON.parse(fs.readFileSync(path.join(ECC_ROOT, 'package.json'), 'utf-8')).version,
  };
}

function deriveCategory(skillId) {
  const map = {
    python: 'Python', golang: 'Go', rust: 'Rust', java: 'Java',
    kotlin: 'Kotlin', cpp: 'C++', csharp: 'C#', dart: 'Dart',
    swift: 'Swift', php: 'PHP', perl: 'Perl', typescript: 'TypeScript',
    django: 'Django', springboot: 'Spring Boot', laravel: 'Laravel',
    nestjs: 'NestJS', security: 'Security', defi: 'DeFi/Web3',
    healthcare: 'Healthcare', hipaa: 'Compliance', database: 'Database',
    postgres: 'Database', docker: 'DevOps', deployment: 'DevOps',
    frontend: 'Frontend', backend: 'Backend', api: 'API', tdd: 'Testing',
    e2e: 'Testing', testing: 'Testing', ai: 'AI/ML', llm: 'AI/ML',
    pytorch: 'AI/ML', mcp: 'MCP', agent: 'Agents', continuous: 'Automation',
    video: 'Media', manim: 'Media', remotion: 'Media', content: 'Content',
    market: 'Business', investor: 'Business', finance: 'Business',
    team: 'Operations', project: 'Operations', customer: 'Operations',
  };
  for (const [prefix, cat] of Object.entries(map)) {
    if (skillId.startsWith(prefix)) return cat;
  }
  return 'General';
}

// ─── Agent Optimizer ──────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'will',
  'your', 'when', 'what', 'how', 'also', 'into', 'more', 'some', 'need',
  'want', 'make', 'build', 'create', 'use', 'used', 'using', 'would',
]);

function extractKeywords(text) {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));
}

function score(keywords, texts) {
  const combined = texts.join(' ').toLowerCase();
  return keywords.reduce((acc, kw) => {
    return acc + (combined.match(new RegExp(kw, 'g')) || []).length;
  }, 0);
}

// Detect domain and task type from keywords
function analyzeIntent(keywords, description) {
  const text = description.toLowerCase();
  const kw = keywords.join(' ');

  const domains = [];
  if (/python|django|flask|fastapi|pip/.test(text)) domains.push('python');
  if (/typescript|javascript|react|next|vue|node/.test(text)) domains.push('typescript');
  if (/rust|cargo/.test(text)) domains.push('rust');
  if (/java|spring|maven|gradle/.test(text)) domains.push('java');
  if (/kotlin|android/.test(text)) domains.push('kotlin');
  if (/golang|go\b/.test(text)) domains.push('golang');
  if (/security|vuln|audit|pentest|owasp/.test(text)) domains.push('security');
  if (/database|sql|postgres|mysql|migration/.test(text)) domains.push('database');
  if (/docker|k8s|kubernetes|deploy|cloud/.test(text)) domains.push('devops');
  if (/machine learning|ml|pytorch|tensorflow|llm|ai/.test(text)) domains.push('ai');
  if (domains.length === 0) domains.push('general');

  const tasks = [];
  if (/review|quality|check|lint|standard/.test(text)) tasks.push('code-review');
  if (/test|tdd|spec|coverage|unit|e2e/.test(text)) tasks.push('testing');
  if (/plan|architect|design|structure/.test(text)) tasks.push('planning');
  if (/fix|debug|error|bug|resolve/.test(text)) tasks.push('debugging');
  if (/security|vuln|scan|safe/.test(text)) tasks.push('security-scan');
  if (/doc|docstring|readme|comment/.test(text)) tasks.push('documentation');
  if (/refactor|clean|simplify|optimize/.test(text)) tasks.push('refactoring');
  if (/deploy|ci|cd|pipeline/.test(text)) tasks.push('deployment');
  if (tasks.length === 0) tasks.push('general-assistance');

  // Complexity determines model
  const complexitySignals = [
    /reason|analyz|architect|strateg|complex|multipl|orchestrat/.test(text),
    tasks.includes('planning') || tasks.includes('security-scan'),
    domains.length > 2,
  ].filter(Boolean).length;

  let model = 'sonnet';
  if (complexitySignals >= 2 || /deep|comprehensive|complex|architect/.test(text)) {
    model = 'opus';
  } else if (tasks.length === 1 && /simple|quick|fast|basic/.test(text)) {
    model = 'haiku';
  }

  return { domains, tasks, model };
}

// Select minimal tool set needed for the tasks
function selectTools(tasks, domains) {
  const toolMap = {
    'code-review':     ['Read', 'Grep', 'Glob'],
    'testing':         ['Read', 'Bash', 'Grep', 'Glob'],
    'planning':        ['Read', 'Grep', 'Glob'],
    'debugging':       ['Read', 'Bash', 'Grep', 'Glob'],
    'security-scan':   ['Read', 'Grep', 'Glob', 'Bash'],
    'documentation':   ['Read', 'Grep', 'Glob', 'Write'],
    'refactoring':     ['Read', 'Edit', 'Grep', 'Glob'],
    'deployment':      ['Read', 'Bash', 'Glob'],
    'general-assistance': ['Read', 'Grep', 'Glob', 'Bash'],
  };
  const toolSet = new Set();
  for (const task of tasks) {
    for (const tool of (toolMap[task] || [])) toolSet.add(tool);
  }
  return [...toolSet].sort();
}

// Generate an optimized agent system prompt
function generateSystemPrompt(description, domains, tasks, tools) {
  const domainLabel = domains[0] === 'general' ? 'software' : domains.join('/');
  const primaryTask = tasks[0].replace(/-/g, ' ');

  const roleMap = {
    'code-review':     `senior ${domainLabel} code reviewer`,
    'testing':         `${domainLabel} test engineering specialist`,
    'planning':        `${domainLabel} implementation planner`,
    'debugging':       `${domainLabel} debugging specialist`,
    'security-scan':   `application security analyst`,
    'documentation':   `technical documentation specialist`,
    'refactoring':     `${domainLabel} refactoring specialist`,
    'deployment':      `DevOps and deployment engineer`,
    'general-assistance': `${domainLabel} engineering assistant`,
  };

  const role = roleMap[tasks[0]] || `${domainLabel} specialist`;

  const processMap = {
    'code-review': [
      'Read the target file(s) and surrounding context fully before reviewing.',
      'Apply domain-specific standards and security patterns.',
      'Rate findings by severity: CRITICAL, HIGH, MEDIUM, LOW.',
      'Only report issues with >80% confidence — avoid noise.',
      'Consolidate related issues rather than listing duplicates.',
    ],
    'testing': [
      'Understand the feature under test before writing any code.',
      'Write the failing test first (Red), then implement (Green), then refactor.',
      'Prefer integration tests over mocks for external dependencies.',
      'Aim for 80%+ branch coverage on new code.',
      'Name tests descriptively: `test_<behavior>_when_<condition>`.',
    ],
    'planning': [
      'Analyze requirements completely before proposing a plan.',
      'Break work into atomic steps with clear acceptance criteria.',
      'Identify risks, dependencies, and rollback strategies.',
      'Estimate complexity per step (S/M/L).',
      'Present the plan as a numbered checklist.',
    ],
    'debugging': [
      'Reproduce the issue before attempting any fix.',
      'Read error messages and stack traces fully.',
      'Narrow down the root cause — do not patch symptoms.',
      'Verify the fix does not break adjacent functionality.',
      'Document the root cause in a comment if non-obvious.',
    ],
    'security-scan': [
      'Map the attack surface before running checks.',
      'Check OWASP Top 10 categories systematically.',
      'Scan for secrets, hardcoded credentials, and insecure configs.',
      'Report findings with CVSS-style severity and remediation steps.',
      'Never suggest security theatre — focus on real risk reduction.',
    ],
  };

  const steps = processMap[tasks[0]] || [
    'Understand the request fully before acting.',
    'Read relevant files and context before making changes.',
    'Apply domain best practices and coding standards.',
    'Verify your output meets the stated requirements.',
  ];

  const domainRules = {
    python:     '- Follow PEP 8, use type hints, prefer dataclasses over dicts for structured data.',
    typescript: '- Enforce strict TypeScript, avoid `any`, prefer readonly types.',
    rust:       '- Prefer safe Rust, minimize `unsafe`, handle all `Result` and `Option` types.',
    java:       '- Follow effective Java patterns, prefer immutability, avoid checked exceptions where possible.',
    security:   '- Never suggest storing secrets in code. Flag all injection vectors. Prefer allowlisting.',
    database:   '- Always use parameterized queries. Never construct SQL with string concatenation.',
  };

  const domainSpecific = domains
    .map(d => domainRules[d])
    .filter(Boolean)
    .join('\n');

  const outputFormat = tasks.includes('code-review') || tasks.includes('security-scan')
    ? `\n## Output Format\n\nGroup findings by severity:\n\`\`\`\n🔴 CRITICAL: <title>\n  File: <path>:<line>\n  Issue: <description>\n  Fix: <remediation>\n\`\`\``
    : tasks.includes('planning')
    ? `\n## Output Format\n\nReturn a structured plan:\n\`\`\`\n## Plan: <title>\n### Steps\n1. [ ] <action> (<complexity>)\n2. [ ] <action> (<complexity>)\n### Risks\n- <risk> → <mitigation>\n\`\`\``
    : '';

  return `You are a ${role} specialized in ${domainLabel} ${primaryTask}.

## Process

${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${domainSpecific ? `\n## Domain Rules\n\n${domainSpecific}` : ''}
## Constraints

- Only use tools from this set: ${tools.join(', ')}.
- Never make changes outside the stated scope.
- Exit cleanly on non-critical errors — log to stderr with a clear prefix.
- Be concise in output: lead with findings, not preamble.
${outputFormat}`;
}

// Estimate token count (rough: ~0.75 tokens per character for English prose)
function estimateTokens(text) {
  return Math.round(text.length * 0.28);
}

// Cost per 1000 interactions (avg input+output)
function calcCost(model, inputTokens, outputTokens = 500) {
  const p = MODEL_PRICING[model];
  return ((inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output) * 1000;
}

function buildOptimizationReport(description) {
  const keywords = extractKeywords(description);
  const { domains, tasks, model } = analyzeIntent(keywords, description);
  const tools = selectTools(tasks, domains);
  const systemPrompt = generateSystemPrompt(description, domains, tasks, tools);

  // Build the agent file content
  const agentId = [domains[0], tasks[0]].join('-').replace(/\s+/g, '-');
  const agentName = `${domains[0] === 'general' ? '' : domains[0] + '-'}${tasks[0].replace(/-/g, '-')}`;
  const shortDesc = `${domains[0] === 'general' ? 'General' : domains[0].charAt(0).toUpperCase() + domains[0].slice(1)} ${tasks[0].replace(/-/g, ' ')} specialist. Auto-generated and optimized by AgentDoctor.`;

  const agentFile = `---
name: ${agentName}
description: ${shortDesc}
tools: ${JSON.stringify(tools)}
model: ${model}
---

${systemPrompt}`;

  // ── Baseline (naive, unoptimized) ──────────────────────────────────────────
  // Assumes: opus model, all 8 tools, generic prompt
  const ALL_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'Agent'];
  const naivePrompt = `You are a helpful AI assistant. Help the user with their request: ${description}`;
  const naiveInputTokens = estimateTokens(naivePrompt) + 800; // overhead
  const naiveModel = 'opus';
  const naiveCostPer1k = calcCost(naiveModel, naiveInputTokens);

  // ── Optimized ──────────────────────────────────────────────────────────────
  const optimizedInputTokens = estimateTokens(systemPrompt);
  const optimizedCostPer1k = calcCost(model, optimizedInputTokens);

  const tokenReduction = Math.round((1 - optimizedInputTokens / naiveInputTokens) * 100);
  const costReduction = Math.round((1 - optimizedCostPer1k / naiveCostPer1k) * 100);
  const toolReduction = Math.round((1 - tools.length / ALL_TOOLS.length) * 100);

  // ── Optimizations applied ──────────────────────────────────────────────────
  const optimizations = [];

  // Model selection
  if (model !== 'opus') {
    const savings = Math.round((1 - MODEL_PRICING[model].input / MODEL_PRICING.opus.input) * 100);
    optimizations.push({
      category: 'Model Selection',
      icon: '🎯',
      before: `Claude Opus 4.6 (default — $${MODEL_PRICING.opus.input}/MTok)`,
      after: `${MODEL_PRICING[model].label} ($${MODEL_PRICING[model].input}/MTok)`,
      impact: `${savings}% cost reduction per token`,
      reason: model === 'haiku'
        ? 'Task is simple and well-scoped — Haiku handles it with faster, cheaper inference.'
        : 'Task complexity matches Sonnet — Opus-level reasoning is not required.',
    });
  } else {
    optimizations.push({
      category: 'Model Selection',
      icon: '🎯',
      before: 'No model specified (defaults vary)',
      after: `Claude Opus 4.6 — justified for complex multi-domain reasoning`,
      impact: 'Correct model for task depth',
      reason: 'Task involves architectural planning or multi-domain complexity requiring Opus.',
    });
  }

  // Tool minimization
  const removedTools = ALL_TOOLS.filter(t => !tools.includes(t));
  if (removedTools.length > 0) {
    optimizations.push({
      category: 'Tool Minimization',
      icon: '🔧',
      before: `All ${ALL_TOOLS.length} tools enabled (${ALL_TOOLS.join(', ')})`,
      after: `${tools.length} tools selected (${tools.join(', ')})`,
      impact: `${toolReduction}% smaller tool surface — reduces hallucinated tool calls`,
      reason: `Tasks (${tasks.join(', ')}) only require: ${tools.join(', ')}. Removed: ${removedTools.join(', ')}.`,
    });
  }

  // Prompt engineering
  optimizations.push({
    category: 'Prompt Engineering',
    icon: '✍️',
    before: `Generic prompt (~${naiveInputTokens} tokens): "You are a helpful assistant..."`,
    after: `Structured system prompt (~${optimizedInputTokens} tokens) with role, process, constraints, output format`,
    impact: `${tokenReduction}% fewer input tokens — direct cost and latency reduction`,
    reason: 'Focused prompts with clear process steps reduce token usage, improve output consistency, and lower error rate.',
  });

  // Domain-specific rules
  if (domains[0] !== 'general') {
    optimizations.push({
      category: 'Domain Specialization',
      icon: '📚',
      before: 'No domain knowledge — relies on general training',
      after: `Domain rules for ${domains.join(', ')} injected into system prompt`,
      impact: 'Higher accuracy on domain-specific patterns and anti-patterns',
      reason: `Explicit ${domains[0]} rules (coding standards, security patterns) prevent common mistakes without trial-and-error.`,
    });
  }

  // Output format
  if (tasks.includes('code-review') || tasks.includes('security-scan') || tasks.includes('planning')) {
    optimizations.push({
      category: 'Structured Output',
      icon: '📋',
      before: 'Free-form text response — hard to parse or act on',
      after: 'Defined output schema with severity grouping and remediation fields',
      impact: 'Machine-readable output, no post-processing needed',
      reason: 'Structured output enables downstream automation (CI gates, dashboards, ticket creation).',
    });
  }

  // Confidence filtering (for review tasks)
  if (tasks.includes('code-review') || tasks.includes('security-scan')) {
    optimizations.push({
      category: 'Confidence Filtering',
      icon: '🎛️',
      before: 'Reports all potential issues (high noise)',
      after: '>80% confidence threshold — only actionable findings',
      impact: 'Signal-to-noise ratio improvement: fewer false positives',
      reason: 'Review fatigue from noisy output causes developers to ignore real issues.',
    });
  }

  // ── Matching recommendations ───────────────────────────────────────────────
  const allAgents = loadAgents();
  const allSkills = loadSkills();
  const allCommands = loadCommands();

  const topAgents = allAgents
    .map(a => ({ ...a, score: score(keywords, [a.name, a.description]) }))
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ fullContent: _f, ...rest }) => rest);

  const topSkills = allSkills
    .map(s => ({ ...s, score: score(keywords, [s.id, s.name, s.description]) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const topCommands = allCommands
    .map(c => ({ ...c, score: score(keywords, [c.id, c.description]) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  // ── Performance score ─────────────────────────────────────────────────────
  // Scored out of 100 based on specificity signals
  const perfScore = Math.min(100, Math.round(
    20 +                                              // base
    (model !== 'opus' ? 20 : 10) +                   // model fit
    (tools.length < ALL_TOOLS.length ? 15 : 0) +     // tool minimization
    (domains[0] !== 'general' ? 15 : 5) +            // domain specificity
    (tasks.length > 0 ? 10 : 0) +                    // task clarity
    (tasks.includes('code-review') || tasks.includes('security-scan') ? 10 : 5) + // output format
    Math.min(10, optimizations.length * 2)           // breadth of optimizations
  ));

  return {
    agentId,
    agentFile,
    agentName,
    model,
    tools,
    domains,
    tasks,
    optimizations,
    metrics: {
      before: {
        model: naiveModel,
        modelLabel: MODEL_PRICING[naiveModel].label,
        tokens: naiveInputTokens,
        tools: ALL_TOOLS.length,
        costPer1k: naiveCostPer1k.toFixed(2),
        costPer10k: (naiveCostPer1k * 10).toFixed(2),
        promptType: 'Generic, unstructured',
      },
      after: {
        model,
        modelLabel: MODEL_PRICING[model].label,
        tokens: optimizedInputTokens,
        tools: tools.length,
        costPer1k: optimizedCostPer1k.toFixed(2),
        costPer10k: (optimizedCostPer1k * 10).toFixed(2),
        promptType: 'Structured, domain-specific',
      },
      tokenReduction,
      costReduction,
      toolReduction,
      perfScore,
      monthlySavings: ((naiveCostPer1k - optimizedCostPer1k) * 10).toFixed(2), // per 10k/month
    },
    recommendations: {
      agents: topAgents,
      skills: topSkills,
      commands: topCommands,
      installCmd: `npx ecc ${domains[0] === 'general' ? 'full' : domains[0]}`,
    },
  };
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, msg, status = 500) {
  sendJSON(res, { error: msg }, status);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (_) { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/stats' && req.method === 'GET') {
        return sendJSON(res, loadStats());
      }
      if (pathname === '/api/agents' && req.method === 'GET') {
        return sendJSON(res, loadAgents().map(({ fullContent: _f, ...r }) => r));
      }
      if (pathname.startsWith('/api/agents/') && req.method === 'GET') {
        const id = pathname.slice('/api/agents/'.length);
        const agent = loadAgents().find(a => a.id === id);
        if (!agent) return sendError(res, 'Agent not found', 404);
        return sendJSON(res, agent);
      }
      if (pathname === '/api/skills' && req.method === 'GET') {
        return sendJSON(res, loadSkills());
      }
      if (pathname === '/api/commands' && req.method === 'GET') {
        return sendJSON(res, loadCommands());
      }
      if (pathname === '/api/optimize' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.description || body.description.trim().length < 10) {
          return sendError(res, 'Please provide a description of at least 10 characters.', 400);
        }
        return sendJSON(res, buildOptimizationReport(body.description.trim()));
      }
      return sendError(res, 'Not found', 404);
    } catch (err) {
      console.error('[API Error]', err.message);
      return sendError(res, err.message);
    }
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(UI_DIR, filePath.replace(/\.\./g, ''));
  const ext = path.extname(filePath);

  if (!MIME[ext] && ext !== '') {
    res.writeHead(404);
    return res.end('Not found');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(UI_DIR, 'index.html'), (err2, html) => {
        if (err2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  ✦ AgentDoctor — Agent Optimization Platform`);
  console.log(`  ────────────────────────────────────────────`);
  console.log(`  Local:  http://localhost:${PORT}`);
  console.log(`  Press Ctrl+C to stop\n`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`  Port ${PORT} is in use. Try: PORT=3848 npm run ui`);
  } else {
    console.error('[Server Error]', err);
  }
  process.exit(1);
});
