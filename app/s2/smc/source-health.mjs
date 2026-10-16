export function sourceErrorLabel(reason) {
  if (/CONTEXT_HISTORY_CHANGED/.test(reason ?? '')) return '收线数据发生变动，结构一致性待恢复';
  if (/CONTEXT|CHECKPOINT/.test(reason ?? '')) return '结构数据暂不可用，等待恢复';
  return '扫描数据异常，等待恢复';
}
