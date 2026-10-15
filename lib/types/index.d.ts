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
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
export declare class CodexCompactionEngine extends BasicCompactionEngine {
    /**
     * 纯确定性摘要：不调用 LLM，返回官方 SummaryResult 契约的模板分支
     * （无 llmStreamCall 字段；rawOutput 与 summary 相同）。
     */
    protected summarize(input: any, agent: any, _signal?: AbortSignal): Promise<any>;
}
export default CodexCompactionEngine;
