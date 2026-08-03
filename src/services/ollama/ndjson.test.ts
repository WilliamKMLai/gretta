import { NdjsonParser } from './ndjson';

const enc = new TextEncoder();

describe('NdjsonParser', () => {
  it('returns each completed line, holding back the partial tail', () => {
    const parser = new NdjsonParser();
    expect(parser.push(enc.encode('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
    expect(parser.push(enc.encode('2}\n'))).toEqual(['{"b":2}']);
    expect(parser.flush()).toEqual([]);
  });

  it('handles several lines arriving in one chunk', () => {
    const parser = new NdjsonParser();
    expect(parser.push(enc.encode('{"a":1}\n{"b":2}\n{"c":3}\n'))).toEqual([
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
    ]);
  });

  it('reassembles a multi-byte character split across chunks', () => {
    const parser = new NdjsonParser();
    const bytes = enc.encode('{"t":"🦙"}\n');
    const splitAt = 6; // inside the 4-byte llama emoji
    expect(parser.push(bytes.slice(0, splitAt))).toEqual([]);
    expect(parser.push(bytes.slice(splitAt))).toEqual(['{"t":"🦙"}']);
  });

  it('skips blank lines and strips \\r', () => {
    const parser = new NdjsonParser();
    expect(parser.push(enc.encode('{"a":1}\r\n\n  \n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('flush() surfaces a final line that never got its newline', () => {
    const parser = new NdjsonParser();
    expect(parser.push(enc.encode('{"done":true}'))).toEqual([]);
    expect(parser.flush()).toEqual(['{"done":true}']);
    expect(parser.flush()).toEqual([]);
  });
});
