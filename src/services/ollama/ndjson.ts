/**
 * Incremental NDJSON line splitter (ARCHITECTURE.md §7.2, §10).
 *
 * Ollama streams one JSON object per `\n`-terminated line, but the network
 * hands us arbitrary byte chunks: a chunk may end mid-line or even mid-way
 * through a multi-byte UTF-8 character. `TextDecoder` in streaming mode owns
 * the byte-boundary problem; this class owns the line-boundary problem.
 * It deliberately does NOT parse JSON — validation is schemas.ts's job.
 */
export class NdjsonParser {
  private readonly decoder = new TextDecoder();
  private buffer = '';

  /** Feeds one network chunk; returns every newly *completed* line (trimmed, non-empty). */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const parts = this.buffer.split('\n');
    // The final part is either '' (chunk ended exactly on \n) or a partial line.
    this.buffer = parts.pop() ?? '';
    return parts.map((line) => line.trim()).filter((line) => line !== '');
  }

  /**
   * Ends the stream: flushes any bytes the decoder was holding and returns a
   * trailing line that never got its `\n` (some servers omit it on the last
   * line). Empty array when the stream ended cleanly on a newline.
   */
  flush(): string[] {
    this.buffer += this.decoder.decode();
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest === '' ? [] : [rest];
  }
}
