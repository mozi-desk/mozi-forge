/**
 * Purpose: Prove the Trainer persona the real Loader composes carries the human-facing reporting contract.
 * Flow: mount the versioned Trainer preset through the real fixture, run one scripted turn, and read the
 * leading system-role message of the exact model request — the text the model is given, not a file on disk.
 * Example: before the contract exists the recorded prompt lacks "product owner" and the test fails;
 * after trainer-prompt.md gains the Reporting to the human section the same request contains every phrase.
 * The recording adapter is deterministic and never contacts a provider.
 */
import { expect, it } from 'vitest'
import { LlmAdapter, MessageId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { fixture } from './trainer-fixture.js'

/** Phrases the Reporting to the human section must contribute to every Trainer turn. */
const CONTRACT_PHRASES = [
  'product owner who does not read internal documents',
  'two or three concrete options and mark one as recommended',
  'Never build a decision list out of internal identifiers',
  'Do not ask the human to read, review or approve an internal document',
  'Decide mechanical internals yourself',
]

/**
 * Records the assembled system prompt of every request while answering deterministically.
 *
 * Logic:
 * 1. Capture the leading system-role message of the loop-built history, which carries the rendered prompt.
 * 2. Emit a fixed text answer so the turn settles without a provider.
 */
class RecordingModel extends LlmAdapter {
  readonly prompts: string[] = []
  resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.prompts.push(options.messages.filter(message => message.role === 'system').flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n'))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Recorded.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recorded.' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('delivers the human-facing reporting contract in the assembled Trainer prompt', async () => {
  const model = new RecordingModel()
  const f = await fixture(model)
  try {
    f.handle.agent.followup({ id: MessageId('reporting-contract-probe'), role: 'user', content: [{ type: 'text', text: '现在有哪些需要我决策的内容？' }], source: { kind: 'user' } })
    await f.handle.agent.whenIdle()
    expect(model.prompts.length).toBeGreaterThan(0)
    const prompt = model.prompts[0]!
    for (const phrase of CONTRACT_PHRASES) expect(prompt).toContain(phrase)
  } finally {
    await f.dispose()
  }
})
