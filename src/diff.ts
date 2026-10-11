import parseDiff from 'parse-diff';
import { classify } from './classify.js';
import type { AddedLine, ChangedFile, FileStatus } from './types.js';

const NULL = '/dev/null';

export function parseChanges(diff: string): ChangedFile[] {
  return parseDiff(diff).map((f) => {
    const path = (f.to && f.to !== NULL ? f.to : f.from) ?? '';
    const status: FileStatus = f.new
      ? 'added'
      : f.deleted
        ? 'deleted'
        : f.from && f.to && f.from !== f.to
          ? 'renamed'
          : 'modified';
    const added: AddedLine[] = [];
    const removed: string[] = [];
    for (const chunk of f.chunks) {
      for (const change of chunk.changes) {
        if (change.type === 'add') added.push({ line: change.ln, text: change.content.slice(1) });
        else if (change.type === 'del') removed.push(change.content.slice(1));
      }
    }
    return {
      path,
      oldPath: status === 'renamed' ? f.from : undefined,
      status,
      kind: classify(path),
      added,
      removed,
    };
  });
}
