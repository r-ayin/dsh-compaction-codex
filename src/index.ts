/**
 * dsh-compaction-codex — Codex 式换窗压缩引擎（纯确定性，零 LLM 摘要）。
 *
 * 官方 dsh-compaction-basic 压缩时调用 LLM 生成对话摘要（summarizeWithLlm）。
 * 本包继承 BasicCompactionEngine，只覆写官方承诺的唯一子类钩子 summarize()，
 * 替换为确定性「归档指针」模板：归档声明 + notes 检查点 + 首尾锚点 + 检索指引。
 * shadow 事务、replay 定价、工具配对平衡、并发锁、阈值触发（0.8x窗口）、
 * context-overflow 恢复、/compact（compactNow）全部机制原样继承官方实现。
 *
 * SummaryResult 走官方契约的模板分支（llmStreamCall 缺省，注释点名
 * "template, remote, or other summarizer"）：不调用 ctx.llm、零辅助请求、
 * 不破坏会话前缀缓存。
 *
 * 装配：替换 preset compaction 组中的 compaction-basic 条目。
 * 约束：官方 summarizeCompaction 要求摘要帧 token 数 < 被 shadow 内容 token 数；
 * 本模板全文上限约 9K 字符（约 2.7K tokens），且尾部保留区预算自适应压缩区
 * 总字符数的 1/4（超预算从最旧消息整条丢弃），对任何规模的压缩区安全。
 */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NOTES_DIR = path.join(os.homedir(), '.dsh', 'context-budget', 'notes')
const MAX_NOTES_CHARS = 4000
const MAX_ANCHOR_CHARS = 300
const MAX_NOTE_ENTRIES = 2
/** 尾部原样保留：最后几条完整对话消息（最新的信息最关键）。 */
const MAX_TAIL_MESSAGES = 4
const MAX_TAIL_MESSAGE_CHARS = 1500
const MAX_TAIL_TOTAL_CHARS = 4000
/** 尾部预算下限：即使归档区很小也至少保留这么多字符。 */
const MIN_TAIL_BUDGET_CHARS = 800

const safe = (s: string): string => String(s).replace(/[^A-Za-z0-9_.-]/g, '_')

/** 从一条消息提取纯文本（content 可能是字符串或 ContentBlock 数组）。 */
function messageText(msg: unknown): string {
  try {
    const m = msg as { role?: string; content?: unknown }
    const c = m && m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .map((b: any) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
        .filter(Boolean)
        .join('\n')
    }
  } catch { /* noop */ }
  return ''
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/** 原样截断：保留换行与内部格式，超长时截尾并标注。 */
function truncateVerbatim(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? t.slice(0, max) + '\n…[已截断，全文可用 history_search 找回]' : t
}

const ROLE_LABELS: Record<string, string> = { user: '用户', assistant: '助手', system: '系统', tool: '工具' }

/**
 * 取归档区最后几条有文本的消息，原样保留（带角色标签）。
 * 预算自适应：不超过归档区总字符数的 1/4，确保摘要帧恒小于被 shadow 内容
 * （官方 summarizeCompaction 的硬约束）；超预算时从最旧的一条开始整条丢弃，
 * 最新的消息永远优先保留。
 */
function buildTailSection(messages: any[]): string {
  const tail: { role: string; text: string }[] = []
  for (let i = messages.length - 1; i >= 0 && tail.length < MAX_TAIL_MESSAGES; i--) {
    const t = messageText(messages[i])
    if (t) tail.unshift({ role: String((messages[i] && messages[i].role) || 'unknown'), text: t })
  }
  if (!tail.length) return ''
  let totalChars = 0
  for (const m of messages) totalChars += messageText(m).length
  let budget = Math.min(MAX_TAIL_TOTAL_CHARS, Math.max(MIN_TAIL_BUDGET_CHARS, Math.floor(totalChars / 4)))
  const perMessage = Math.max(200, Math.min(MAX_TAIL_MESSAGE_CHARS, Math.floor(budget / tail.length)))
  let parts = tail.map((m) => {
    const label = ROLE_LABELS[m.role] || m.role
    return '[' + label + ']\n' + truncateVerbatim(m.text, perMessage)
  })
  let joined = parts.join('\n---\n')
  while (joined.length > budget && parts.length > 1) {
    parts.shift()
    joined = parts.join('\n---\n')
  }
  if (joined.length > budget) joined = joined.slice(-budget)
  return '—— 归档区最后 ' + parts.length + ' 条消息（原样保留，最新信息最关键）——\n' + joined
}

/** 读取该会话最近的 model 检查点笔记（context-budget 落盘目录，只读）。 */
function readModelCheckpoints(sessionId: string): string {
  if (!sessionId) return ''
  try {
    const file = path.join(NOTES_DIR, safe(sessionId) + '.jsonl')
    if (!fs.existsSync(file)) return ''
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const entries: { ts: number; text: string }[] = []
    for (const ln of lines) {
      try {
        const e = JSON.parse(ln)
        if (e && e.source === 'model' && typeof e.text === 'string') entries.push({ ts: Number(e.ts) || 0, text: e.text })
      } catch { /* 容忍坏行 */ }
    }
    const latest = entries.slice(-MAX_NOTE_ENTRIES)
    if (!latest.length) return ''
    let out = latest
      .map((e) => {
        const when = e.ts ? new Date(e.ts).toLocaleString('zh-CN', { hour12: false }) : '时间未知'
        return '[' + when + ']\n' + e.text
      })
      .join('\n---\n')
    if (out.length > MAX_NOTES_CHARS) out = out.slice(-MAX_NOTES_CHARS)
    return out
  } catch { return '' }
}

export class CodexCompactionEngine extends BasicCompactionEngine {
  /**
   * 纯确定性摘要：不调用 LLM，返回官方 SummaryResult 契约的模板分支
   * （无 llmStreamCall 字段；rawOutput 与 summary 相同）。
   */
  protected async summarize(input: any, agent: any, _signal?: AbortSignal): Promise<any> {
    const sessionId = String((agent && agent.session && agent.session.id) || '')
    const messages: any[] = Array.isArray(input && input.messages) ? input.messages : []

    let firstUser = ''
    for (const m of messages) {
      if (m && m.role === 'user') {
        const t = messageText(m)
        if (t) { firstUser = truncate(t, MAX_ANCHOR_CHARS); break }
      }
    }
    const tailSection = buildTailSection(messages)

    const notes = readModelCheckpoints(sessionId)
    const parts: string[] = []
    parts.push('[换窗归档 · Codex 模式] 此前窗口的 ' + messages.length + ' 条对话消息已移出上下文。未生成 LLM 摘要；全部原文永久保留在会话转录中，可随时精确找回。')
    parts.push('恢复通道（按需使用，不要凭记忆猜测归档区内容）：\n- history_search "<关键词>"：全文检索归档原文（含被 shadow 的轮次）\n- history_read：按 seq 范围读取原文\n- notes read：读取跨压缩任务检查点')
    if (notes) parts.push('—— 最近任务检查点（notes，model 写入）——\n' + notes)
    if (firstUser) parts.push('—— 归档区首条用户消息（截断锚点）——\n' + firstUser)
    if (tailSection) parts.push(tailSection)
    parts.push('请先依据上述检查点确认任务状态，然后继续当前工作。')

    const text = parts.join('\n\n')
    const block = { type: 'text', text }
    return {
      summary: [block],
      provider: 'template',
      model: 'codex-rollover',
      rawOutput: [block],
    }
  }
}

export default CodexCompactionEngine
